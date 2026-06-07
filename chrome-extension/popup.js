const DEFAULT_API_URL = "http://127.0.0.1:39876";

const apiUrlInput = document.getElementById("apiUrl");
const apiTokenInput = document.getElementById("apiToken");
const startButton = document.getElementById("startButton");
const message = document.getElementById("message");
const stats = document.getElementById("stats");
const stateBadge = document.getElementById("stateBadge");
let pollTimer = null;

function setStatus(text, badge = "готово") {
  message.textContent = text;
  stateBadge.textContent = badge;
}

function renderScanState(scanState) {
  if (scanState.running) {
    startButton.disabled = true;
    const elapsed = scanState.startedMs ? Math.max(0, Date.now() - scanState.startedMs) : 0;
    const left = scanState.timeoutMs ? Math.max(0, scanState.timeoutMs - elapsed) : 0;
    setStatus("Проверка выполняется. Popup можно закрыть, сбор продолжится.", "сбор");
    stats.textContent = `Собрано запросов: ${scanState.requestCount}. Завершение примерно через ${Math.ceil(left / 1000)} сек.`;
    return;
  }

  startButton.disabled = false;
  if (scanState.lastResult?.status === "finished") {
    setStatus("Список доменов передан в ZPRT App.", "готово");
    stats.textContent = `Передано доменов: ${scanState.lastResult.requestCount}`;
    return;
  }
  if (scanState.lastResult?.status === "failed") {
    setStatus(scanState.lastResult.error || "Не удалось передать данные в ZPRT App.", "ошибка");
    stats.textContent = "";
    return;
  }

  setStatus("Откройте проблемную страницу и запустите проверку.", "готово");
  stats.textContent = "";
}

async function refreshScanState() {
  const scanState = await chrome.runtime.sendMessage({ type: "GET_SCAN_STATE" });
  renderScanState(scanState || { running: false, requestCount: 0 });
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    refreshScanState().catch(() => undefined);
  }, 1000);
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(["apiUrl", "apiToken"]);
  apiUrlInput.value = stored.apiUrl || DEFAULT_API_URL;
  apiTokenInput.value = stored.apiToken || "";
  await refreshScanState();
  startPolling();
}

async function saveSettings() {
  await chrome.storage.local.set({
    apiUrl: apiUrlInput.value.trim() || DEFAULT_API_URL,
    apiToken: apiTokenInput.value.trim(),
  });
}

async function startScan() {
  await saveSettings();
  startButton.disabled = true;
  stats.textContent = "";
  setStatus("Страница перезагружается, запросы собираются...", "сбор");

  const response = await chrome.runtime.sendMessage({
    type: "START_SCAN",
    payload: {
      apiUrl: apiUrlInput.value.trim() || DEFAULT_API_URL,
      apiToken: apiTokenInput.value.trim(),
    },
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Не удалось запустить проверку");
  }

  await refreshScanState();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "SCAN_FINISHED") {
    startButton.disabled = false;
    setStatus("Список доменов передан в ZPRT App.", "готово");
    stats.textContent = `Передано доменов: ${message.payload.requestCount}`;
  }
  if (message?.type === "SCAN_FAILED") {
    startButton.disabled = false;
    setStatus(message.payload.error || "Не удалось передать данные в ZPRT App.", "ошибка");
    stats.textContent = "";
  }
});

startButton.addEventListener("click", () => {
  startScan().catch((error) => {
    startButton.disabled = false;
    setStatus(error.message || String(error), "ошибка");
  });
});

apiUrlInput.addEventListener("change", () => void saveSettings());
apiTokenInput.addEventListener("change", () => void saveSettings());
window.addEventListener("unload", () => {
  if (pollTimer) clearInterval(pollTimer);
});

loadSettings().catch((error) => setStatus(String(error), "ошибка"));
