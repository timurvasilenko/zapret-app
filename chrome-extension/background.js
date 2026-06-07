const DEFAULT_API_URL = "http://127.0.0.1:39876";
const SCAN_TIMEOUT_MS = 20000;
const FINISH_ALARM = "zprt-finish-scan";

const state = {
  session: null,
  finishTimer: null,
};

function normalizeDomain(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

function isHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function pickTargetPageUrl() {
  if (!state.session) return "";
  if (isHttpUrl(state.session.pageUrl)) {
    return state.session.pageUrl;
  }

  const mainFrame = Array.from(state.session.requests.values()).find(
    (request) => request.type === "main_frame" && isHttpUrl(request.url),
  );
  if (mainFrame) {
    return mainFrame.url;
  }

  const firstRequest = Array.from(state.session.requests.values()).find((request) =>
    isHttpUrl(request.url),
  );
  return firstRequest?.url || state.session.pageUrl;
}

function serializeSession() {
  if (!state.session) return null;
  return {
    ...state.session,
    requests: Array.from(state.session.requests.entries()),
  };
}

function deserializeSession(session) {
  if (!session) return null;
  return {
    ...session,
    requests: new Map(session.requests || []),
  };
}

async function persistSession() {
  await chrome.storage.session.set({ scanSession: serializeSession() });
}

async function clearSession() {
  state.session = null;
  if (state.finishTimer) clearTimeout(state.finishTimer);
  state.finishTimer = null;
  await chrome.alarms.clear(FINISH_ALARM);
  await chrome.storage.session.remove("scanSession");
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => undefined);
}

function ensureListeners() {
  if (!chrome.webRequest.onBeforeRequest.hasListener(onBeforeRequest)) {
    chrome.webRequest.onBeforeRequest.addListener(onBeforeRequest, { urls: ["<all_urls>"] });
  }
  if (!chrome.webRequest.onCompleted.hasListener(onCompleted)) {
    chrome.webRequest.onCompleted.addListener(onCompleted, { urls: ["<all_urls>"] });
  }
  if (!chrome.webRequest.onErrorOccurred.hasListener(onErrorOccurred)) {
    chrome.webRequest.onErrorOccurred.addListener(onErrorOccurred, { urls: ["<all_urls>"] });
  }
  if (!chrome.alarms.onAlarm.hasListener(onAlarm)) {
    chrome.alarms.onAlarm.addListener(onAlarm);
  }
}

function scheduleFinish() {
  if (!state.session || state.session.finished) return;
  if (state.finishTimer) clearTimeout(state.finishTimer);

  const finishAt = state.session.startedMs + SCAN_TIMEOUT_MS;
  const delay = Math.max(0, finishAt - Date.now());
  state.finishTimer = setTimeout(() => {
    finishScan().catch((error) => notifyFailure(error));
  }, delay);
  chrome.alarms.create(FINISH_ALARM, { when: finishAt });
}

function isSessionRequest(details) {
  return state.session && !state.session.finished && details.tabId === state.session.tabId;
}

function rememberRequest(details, patch) {
  if (!isSessionRequest(details)) return;
  const domain = normalizeDomain(details.url);
  if (!domain) return;

  const existing = state.session.requests.get(details.requestId) || {
    url: details.url,
    domain,
    type: details.type,
    statusCode: null,
    error: null,
    initiator: details.initiator || null,
    finalState: "pending",
  };

  state.session.requests.set(details.requestId, {
    ...existing,
    ...patch,
    url: details.url,
    domain,
    type: details.type || existing.type,
    initiator: details.initiator || existing.initiator || null,
  });

  persistSession().catch(() => undefined);
}

function onBeforeRequest(details) {
  rememberRequest(details, { finalState: "pending" });
}

function onCompleted(details) {
  rememberRequest(details, {
    statusCode: details.statusCode || null,
    finalState: "completed",
  });
}

function onErrorOccurred(details) {
  rememberRequest(details, {
    error: details.error || "unknown",
    finalState: "error",
  });
}

function onAlarm(alarm) {
  if (alarm.name === FINISH_ALARM) {
    finishScan().catch((error) => notifyFailure(error));
  }
}

function markPendingRequestsAsTimedOut() {
  if (!state.session) return;
  for (const [requestId, request] of state.session.requests.entries()) {
    if (request.finalState === "pending") {
      state.session.requests.set(requestId, {
        ...request,
        error: "zprt-timeout",
        finalState: "error",
      });
    }
  }
}

function ensurePageRequest() {
  if (!state.session) return;
  const pageUrl = pickTargetPageUrl();
  state.session.pageUrl = pageUrl;
  const domain = normalizeDomain(pageUrl);
  if (!domain) return;
  state.session.requests.set("__page__", {
    url: pageUrl,
    domain,
    type: "main_frame",
    statusCode: null,
    error: "zprt-page-check",
    initiator: null,
    finalState: "error",
  });
}

function uniqueRequestsForApi() {
  if (!state.session) return [];
  const byDomain = new Map();
  for (const request of state.session.requests.values()) {
    const existing = byDomain.get(request.domain);
    if (!existing || request.finalState === "error") {
      byDomain.set(request.domain, request);
    }
  }
  return Array.from(byDomain.values());
}

async function finishScan() {
  if (!state.session || state.session.finished) return;
  state.session.finished = true;
  if (state.finishTimer) clearTimeout(state.finishTimer);
  state.finishTimer = null;
  await chrome.alarms.clear(FINISH_ALARM);

  ensurePageRequest();
  markPendingRequestsAsTimedOut();
  const requests = uniqueRequestsForApi();
  const pageUrl = pickTargetPageUrl();

  const payload = {
    pageUrl,
    startedAt: state.session.startedAt,
    requests,
  };

  await persistSession();

  const response = await fetch(`${state.session.apiUrl}/api/extension/diagnostics`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-ZPRT-Token": state.session.apiToken,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `ZPRT App вернул ошибку ${response.status}`);
  }

  const result = await response.json();
  const requestCount = requests.length;
  await clearSession();
  await chrome.storage.session.set({
    scanLastResult: {
      status: "finished",
      requestCount,
      finishedAt: Date.now(),
    },
  });
  broadcast({ type: "SCAN_FINISHED", payload: { requestCount, result } });
}

async function notifyFailure(error) {
  const message = String(error.message || error);
  await chrome.storage.session.set({
    scanLastResult: {
      status: "failed",
      error: message,
      finishedAt: Date.now(),
    },
  });
  broadcast({ type: "SCAN_FAILED", payload: { error: message } });
}

async function startScan({ apiUrl, apiToken }) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) throw new Error("Активная вкладка не найдена");
  const targetUrl = isHttpUrl(tab.pendingUrl) ? tab.pendingUrl : tab.url;

  ensureListeners();
  state.session = {
    tabId: tab.id,
    pageUrl: targetUrl,
    startedAt: new Date().toISOString(),
    startedMs: Date.now(),
    apiUrl: apiUrl || DEFAULT_API_URL,
    apiToken: apiToken || "",
    requests: new Map(),
    finished: false,
  };

  ensurePageRequest();
  await persistSession();
  scheduleFinish();
  if (isHttpUrl(targetUrl) && tab.url !== targetUrl) {
    await chrome.tabs.update(tab.id, { url: targetUrl });
  } else {
    await chrome.tabs.reload(tab.id, { bypassCache: true });
  }
  return { ok: true };
}

async function restoreSession() {
  const stored = await chrome.storage.session.get(["scanSession"]);
  state.session = deserializeSession(stored.scanSession);
  if (state.session && !state.session.finished) {
    ensureListeners();
    scheduleFinish();
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "START_SCAN") {
    startScan(message.payload)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (message?.type === "GET_SCAN_STATE") {
    chrome.storage.session.get(["scanLastResult"]).then((stored) => {
      sendResponse({
        running: Boolean(state.session && !state.session.finished),
        requestCount: state.session ? state.session.requests.size : 0,
        startedMs: state.session?.startedMs || null,
        timeoutMs: SCAN_TIMEOUT_MS,
        lastResult: stored.scanLastResult || null,
      });
    });
    return true;
  }

  return false;
});

ensureListeners();
restoreSession().catch(() => undefined);
