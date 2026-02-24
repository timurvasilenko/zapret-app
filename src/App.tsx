import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import coolImage from "./img/cool.jpg";

type AppState = {
    installedVersions: string[];
    activeVersion: string | null;
    latestVersion: string | null;
    updateAvailable: boolean;
    strategies: string[];
    selectedStrategy: string | null;
    isRunning: boolean;
    autostartEnabled: boolean;
    notifyUpdateAvailable: boolean;
    listGeneralUser: string;
    listExcludeUser: string;
    ipsetExcludeUser: string;
};

type Tab = "control" | "lists" | "versions";
type ToastType = "success" | "error" | "info";
type UserListKey = "general" | "excludeDomains" | "excludeIps";

type Toast = {
    id: number;
    text: string;
    type: ToastType;
};

const emptyState: AppState = {
    installedVersions: [],
    activeVersion: null,
    latestVersion: null,
    updateAvailable: false,
    strategies: [],
    selectedStrategy: null,
    isRunning: false,
    autostartEnabled: false,
    notifyUpdateAvailable: true,
    listGeneralUser: "",
    listExcludeUser: "",
    ipsetExcludeUser: "",
};

function UpdateToastView() {
    const [text, setText] = useState("Доступна новая версия zapret");

    useEffect(() => {
        const win = getCurrentWebviewWindow();
        let unlisten: (() => void) | undefined;

        win.listen<string>("update-toast-message", (event) => {
            setText(event.payload);
        })
            .then((dispose) => {
                unlisten = dispose;
            })
            .catch(() => {});

        return () => {
            if (unlisten) {
                unlisten();
            }
        };
    }, []);

    return (
        <div className="update-toast-window">
            <div className="update-toast-card">
                <div className="update-toast-title">ZPRT App</div>
                <div className="update-toast-body">{text}</div>
            </div>
        </div>
    );
}

function getListValue(state: AppState, key: UserListKey): string {
    if (key === "general") return state.listGeneralUser;
    if (key === "excludeDomains") return state.listExcludeUser;
    return state.ipsetExcludeUser;
}

export default function App() {
    if (window.location.hash === "#update-toast") {
        return <UpdateToastView />;
    }

    const [state, setState] = useState<AppState>(emptyState);
    const [tab, setTab] = useState<Tab>("control");
    const [busy, setBusy] = useState(false);
    const [savingLists, setSavingLists] = useState(false);
    const [toasts, setToasts] = useState<Toast[]>([]);
    const [showEasterEgg, setShowEasterEgg] = useState(false);
    const [titleClickCount, setTitleClickCount] = useState(0);
    const [selectedListKey, setSelectedListKey] =
        useState<UserListKey>("general");
    const [savedLists, setSavedLists] = useState<Record<UserListKey, string>>({
        general: "",
        excludeDomains: "",
        excludeIps: "",
    });
    const startupUpdateToastShown = useRef(false);
    const easterEggTimeoutRef = useRef<number | null>(null);

    const statusLabel = useMemo(() => {
        if (state.isRunning) return "Запущен";
        return "Остановлен";
    }, [state.isRunning]);

    const hasInstalledVersions = state.installedVersions.length > 0;
    const selectedListValue = getListValue(state, selectedListKey);
    const selectedListDirty = selectedListValue !== savedLists[selectedListKey];
    const selectedListLabel =
        selectedListKey === "general"
            ? "Домены"
            : selectedListKey === "excludeDomains"
              ? "Домены (исключения)"
              : "IP-адреса (исключения)";
    const selectedListPlaceholder =
        selectedListKey === "general"
            ? "Список доменов/IP для обхода"
            : selectedListKey === "excludeDomains"
              ? "Список доменов-исключений"
              : "Список IP-адресов-исключений";

    function showToast(text: string, type: ToastType = "info") {
        const id = Date.now() + Math.floor(Math.random() * 1000);
        setToasts((prev) => [...prev, { id, text, type }]);
        window.setTimeout(() => {
            setToasts((prev) => prev.filter((toast) => toast.id !== id));
        }, 3800);
    }

    async function load() {
        const next = await invoke<AppState>("load_app_state");
        setState(next);
        setSavedLists({
            general: next.listGeneralUser,
            excludeDomains: next.listExcludeUser,
            excludeIps: next.ipsetExcludeUser,
        });
    }

    function setListValue(key: UserListKey, value: string) {
        setState((prev) => {
            if (key === "general") return { ...prev, listGeneralUser: value };
            if (key === "excludeDomains")
                return { ...prev, listExcludeUser: value };
            return { ...prev, ipsetExcludeUser: value };
        });
    }

    async function saveSelectedList(showSuccessToast = true) {
        const content = getListValue(state, selectedListKey);
        if (savedLists[selectedListKey] === content) {
            return;
        }

        setSavingLists(true);
        try {
            await invoke("save_user_list_file", {
                listKind: selectedListKey,
                content,
            });
            setSavedLists((prev) => ({ ...prev, [selectedListKey]: content }));
            if (showSuccessToast) {
                showToast("Список сохранён", "success");
            }
        } catch (error) {
            showToast(String(error), "error");
        } finally {
            setSavingLists(false);
        }
    }

    async function runAction(action: () => Promise<void>, okMessage?: string) {
        setBusy(true);
        try {
            await action();
            await load();
            if (okMessage) {
                showToast(okMessage, "success");
            }
        } catch (error) {
            showToast(String(error), "error");
        } finally {
            setBusy(false);
        }
    }

    async function checkUpdatesAction() {
        setBusy(true);
        try {
            const next = await invoke<AppState>("refresh_release_info");
            setState(next);
            if (next.updateAvailable) {
                showToast("Доступна новая версия", "info");
            } else {
                showToast("Установлена последняя версия", "success");
            }
        } catch (error) {
            showToast(String(error), "error");
        } finally {
            setBusy(false);
        }
    }

    useEffect(() => {
        load().catch((error) => showToast(String(error), "error"));

        let unlisten: (() => void) | undefined;
        listen("bypass-state-changed", () => {
            load().catch((error) => showToast(String(error), "error"));
        })
            .then((dispose) => {
                unlisten = dispose;
            })
            .catch((error) => {
                showToast(String(error), "error");
            });

        return () => {
            if (unlisten) {
                unlisten();
            }
        };
    }, []);

    useEffect(() => {
        if (!startupUpdateToastShown.current && state.updateAvailable) {
            startupUpdateToastShown.current = true;
            showToast("Доступна новая версия утилиты", "info");
        }
    }, [state.updateAvailable]);

    useEffect(() => {
        if (!hasInstalledVersions && tab !== "versions") {
            setTab("versions");
        }
    }, [hasInstalledVersions, tab]);

    useEffect(() => {
        return () => {
            if (easterEggTimeoutRef.current !== null) {
                window.clearTimeout(easterEggTimeoutRef.current);
            }
        };
    }, []);

    function handleTitleClick() {
        setTitleClickCount((prev) => {
            const next = prev + 1;
            if (next >= 10) {
                setShowEasterEgg(true);
                if (easterEggTimeoutRef.current !== null) {
                    window.clearTimeout(easterEggTimeoutRef.current);
                }
                easterEggTimeoutRef.current = window.setTimeout(() => {
                    setShowEasterEgg(false);
                    easterEggTimeoutRef.current = null;
                }, 5000);
                return 0;
            }
            return next;
        });
    }

    return (
        <main className="app">
            {showEasterEgg && (
                <div className="easter-egg-overlay" aria-hidden="true">
                    <img src={coolImage} alt="" />
                </div>
            )}
            <div className="toast-stack" aria-live="polite" aria-atomic="true">
                {toasts.map((toast) => (
                    <div key={toast.id} className={`toast ${toast.type}`}>
                        {toast.text}
                    </div>
                ))}
            </div>

            <header className="header">
                <h1 onClick={handleTitleClick}>ZPRT App</h1>
            </header>

            <div className="tabs">
                <button
                    className={tab === "control" ? "tab active" : "tab"}
                    onClick={() => setTab("control")}
                    disabled={busy || savingLists || !hasInstalledVersions}
                >
                    Управление
                </button>
                <button
                    className={tab === "lists" ? "tab active" : "tab"}
                    onClick={() => setTab("lists")}
                    disabled={busy || savingLists || !hasInstalledVersions}
                >
                    Списки доменов
                </button>
                <button
                    className={
                        tab === "versions"
                            ? "tab active"
                            : `tab ${state.updateAvailable ? "has-update" : ""}`
                    }
                    onClick={() => setTab("versions")}
                    disabled={busy || savingLists}
                >
                    {state.updateAvailable && (
                        <span className="tab-dot" aria-hidden="true" />
                    )}
                    Версии
                </button>
            </div>

            {tab === "control" && (
                <section className="grid">
                    <div className="card full">
                        <h2>Управление обходом</h2>
                        <div className="row">
                            <strong>Статус:</strong>
                            <span>{statusLabel}</span>
                        </div>

                        <label>
                            Стратегия
                            <select
                                disabled={busy || state.strategies.length === 0}
                                value={state.selectedStrategy ?? ""}
                                onChange={(event) =>
                                    runAction(() =>
                                        invoke("select_strategy", {
                                            strategy: event.target.value,
                                        }).then(() => undefined),
                                    )
                                }
                            >
                                {state.strategies.map((strategy) => (
                                    <option key={strategy} value={strategy}>
                                        {strategy}
                                    </option>
                                ))}
                            </select>
                        </label>

                        <div className="controls">
                            <button
                                disabled={
                                    busy ||
                                    !state.selectedStrategy ||
                                    !state.activeVersion ||
                                    state.isRunning
                                }
                                onClick={() =>
                                    runAction(
                                        () =>
                                            invoke("start_bypass").then(
                                                () => undefined,
                                            ),
                                        "Обход запущен",
                                    )
                                }
                            >
                                Запустить
                            </button>
                            <button
                                disabled={busy || !state.isRunning}
                                onClick={() =>
                                    runAction(
                                        () =>
                                            invoke("stop_bypass").then(
                                                () => undefined,
                                            ),
                                        "Обход остановлен",
                                    )
                                }
                            >
                                Остановить
                            </button>
                        </div>

                        <label className="inline">
                            <input
                                type="checkbox"
                                checked={state.autostartEnabled}
                                onChange={(event) =>
                                    runAction(
                                        () =>
                                            invoke("set_autostart", {
                                                enabled: event.target.checked,
                                            }).then(() => undefined),
                                        event.target.checked
                                            ? "Автозапуск включён"
                                            : "Автозапуск выключен",
                                    )
                                }
                            />
                            Запускать ZPRT App вместе с Windows
                        </label>

                        <button
                            disabled={busy || !state.activeVersion}
                            onClick={() =>
                                runAction(
                                    () =>
                                        invoke("open_service_bat").then(
                                            () => undefined,
                                        ),
                                    "service.bat открыт",
                                )
                            }
                        >
                            Открыть service
                        </button>
                    </div>
                </section>
            )}

            {tab === "lists" && (
                <section className="grid">
                    <div className="card full">
                        <h2>Редактирование списков</h2>

                        <label>
                            Список
                            <select
                                disabled={busy || savingLists}
                                value={selectedListKey}
                                onChange={(event) =>
                                    setSelectedListKey(
                                        event.target.value as UserListKey,
                                    )
                                }
                            >
                                <option value="general">Домены</option>
                                <option value="excludeDomains">
                                    Домены (исключения)
                                </option>
                                <option value="excludeIps">
                                    IP-адреса (исключения)
                                </option>
                            </select>
                        </label>

                        <div className="editors single">
                            <label>
                                <textarea
                                    value={selectedListValue}
                                    onChange={(event) =>
                                        setListValue(
                                            selectedListKey,
                                            event.target.value,
                                        )
                                    }
                                    onBlur={() => {
                                        if (selectedListDirty) {
                                            void saveSelectedList(false);
                                        }
                                    }}
                                    placeholder={selectedListPlaceholder}
                                />
                            </label>
                        </div>

                        <button
                            disabled={savingLists || busy || !selectedListDirty}
                            onClick={() => void saveSelectedList(true)}
                        >
                            Сохранить
                        </button>
                    </div>
                </section>
            )}

            {tab === "versions" && (
                <section className="grid">
                    <div className="card full">
                        <h2>Версии</h2>
                        <div className="row">
                            <strong>Текущая:</strong>
                            <span>{state.activeVersion ?? "не выбрана"}</span>
                        </div>
                        <div className="row">
                            <strong>Последняя:</strong>
                            <span>{state.latestVersion ?? "неизвестно"}</span>
                        </div>

                        <div className="controls">
                            {(state.updateAvailable ||
                                !hasInstalledVersions) && (
                                <button
                                    disabled={busy}
                                    onClick={() =>
                                        runAction(
                                            () =>
                                                invoke("install_latest").then(
                                                    () => undefined,
                                                ),
                                            hasInstalledVersions
                                                ? "Последняя версия установлена"
                                                : "Версия установлена",
                                        )
                                    }
                                >
                                    {hasInstalledVersions
                                        ? "Обновить"
                                        : "Установить"}
                                </button>
                            )}
                            <button
                                disabled={busy}
                                onClick={checkUpdatesAction}
                            >
                                Проверить обновления
                            </button>
                        </div>

                        <label>
                            Выбор версии обхода
                            <select
                                disabled={
                                    busy || state.installedVersions.length === 0
                                }
                                value={state.activeVersion ?? ""}
                                onChange={(event) => {
                                    runAction(
                                        () =>
                                            invoke("switch_active_version", {
                                                version: event.target.value,
                                            }).then(() => undefined),
                                        "Текущая версия изменена",
                                    );
                                }}
                            >
                                {state.installedVersions.map((version) => (
                                    <option key={version} value={version}>
                                        {version}
                                    </option>
                                ))}
                            </select>
                        </label>

                        <label className="inline">
                            <input
                                type="checkbox"
                                checked={state.notifyUpdateAvailable}
                                onChange={(event) =>
                                    runAction(
                                        () =>
                                            invoke(
                                                "set_update_notifications_enabled",
                                                {
                                                    enabled:
                                                        event.target.checked,
                                                },
                                            ).then(() => undefined),
                                        event.target.checked
                                            ? "Уведомления об обновлениях включены"
                                            : "Уведомления об обновлениях выключены",
                                    )
                                }
                            />
                            Уведомлять о наличии новой версии zapret
                        </label>
                    </div>
                </section>
            )}
        </main>
    );
}
