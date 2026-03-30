import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
    ArrowSquareOutIcon,
    CaretUpDownIcon,
    MinusIcon,
    XIcon,
} from "@phosphor-icons/react";
import { Toaster, toast } from "sonner";
import { useTranslation } from "react-i18next";
import coolImage from "./img/cool.jpg";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription } from "@/components/ui/card";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "@/components/ui/command";
import { Label } from "@/components/ui/label";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

type AppState = {
    installedVersions: string[];
    activeVersion: string | null;
    latestVersion: string | null;
    latestReleaseUrl: string | null;
    updateAvailable: boolean;
    updateNotificationNeeded: boolean;
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
type ToastType = "success" | "error" | "info" | "warning";
type UserListKey = "general" | "excludeDomains" | "excludeIps";

const emptyState: AppState = {
    installedVersions: [],
    activeVersion: null,
    latestVersion: null,
    latestReleaseUrl: null,
    updateAvailable: false,
    updateNotificationNeeded: false,
    strategies: [],
    selectedStrategy: null,
    isRunning: false,
    autostartEnabled: false,
    notifyUpdateAvailable: true,
    listGeneralUser: "",
    listExcludeUser: "",
    ipsetExcludeUser: "",
};

function getListValue(state: AppState, key: UserListKey): string {
    if (key === "general") return state.listGeneralUser;
    if (key === "excludeDomains") return state.listExcludeUser;
    return state.ipsetExcludeUser;
}

function formatStrategyName(strategy: string): string {
    return strategy.replace(/\.bat$/i, "");
}

function UpdateToastView() {
    const { t } = useTranslation();
    const [text, setText] = useState(t("toasts.newZapretVersion"));

    async function closeToast() {
        try {
            await invoke("hide_update_toast");
        } catch {
            // noop
        }
    }

    async function openVersions() {
        try {
            await invoke("open_main_versions_from_toast");
        } catch {
            // noop
        }
    }

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
        <div className="h-screen w-screen bg-transparent p-0">
            <Card
                className="h-full cursor-pointer rounded-none border-border bg-card/95 py-0 shadow-xl"
                onClick={() => void openVersions()}
            >
                <CardContent className="relative flex h-full flex-col justify-center gap-1 px-3 py-2">
                    <button
                        type="button"
                        className="absolute right-1 top-1 inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        onClick={(event) => {
                            event.stopPropagation();
                            void closeToast();
                        }}
                        aria-label={t("app.closeNotification")}
                    >
                        <XIcon className="size-4" />
                    </button>
                    <div className="flex items-center gap-2 pr-7 text-[10px] font-semibold uppercase tracking-wide text-primary">
                        <span className="size-1.5 rounded-full bg-primary" />
                        {t("app.title")}
                    </div>
                    <div className="line-clamp-2 pr-7 text-sm leading-snug text-foreground">
                        {text}
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}

function MainApp() {
    const { t } = useTranslation();
    const [state, setState] = useState<AppState>(emptyState);
    const [tab, setTab] = useState<Tab>("control");
    const [isInitialStateLoaded, setIsInitialStateLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [savingLists, setSavingLists] = useState(false);
    const [strategyPickerOpen, setStrategyPickerOpen] = useState(false);
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
    const appWindow = useMemo(() => getCurrentWindow(), []);

    const hasInstalledVersions = state.installedVersions.length > 0;
    const selectedListValue = getListValue(state, selectedListKey);
    const selectedListDirty = selectedListValue !== savedLists[selectedListKey];

    const statusLabel = useMemo(
        () => (state.isRunning ? t("status.running") : t("status.stopped")),
        [state.isRunning, t],
    );

    function showToast(text: string, type: ToastType = "info") {
        if (type === "success") {
            toast.success(text);
            return;
        }
        if (type === "error") {
            toast.error(text);
            return;
        }
        if (type === "warning") {
            toast.warning(text);
            return;
        }
        toast(text);
    }

    async function load() {
        const next = await invoke<AppState>("load_app_state");
        setState(next);
        setSavedLists({
            general: next.listGeneralUser,
            excludeDomains: next.listExcludeUser,
            excludeIps: next.ipsetExcludeUser,
        });
        setIsInitialStateLoaded(true);
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
                showToast(t("toasts.listSaved"), "success");
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
            if (next.updateAvailable && next.updateNotificationNeeded) {
                showToast(t("toasts.updateAvailable"), "warning");
            } else if (!next.updateAvailable) {
                showToast(t("toasts.latestInstalled"), "success");
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
        let unlisten: (() => void) | undefined;
        listen("open-versions-tab", () => {
            setTab("versions");
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

    useEffect(() => {
        if (
            !startupUpdateToastShown.current &&
            state.updateAvailable &&
            state.updateNotificationNeeded
        ) {
            startupUpdateToastShown.current = true;
            showToast(t("toasts.newUtilityVersion"), "warning");
        }
    }, [state.updateAvailable, state.updateNotificationNeeded, t]);

    useEffect(() => {
        if (
            isInitialStateLoaded &&
            !hasInstalledVersions &&
            tab !== "versions"
        ) {
            setTab("versions");
        }
    }, [hasInstalledVersions, isInitialStateLoaded, tab]);

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

    async function minimizeWindow() {
        try {
            await appWindow.minimize();
        } catch (error) {
            showToast(String(error), "error");
        }
    }

    async function closeWindow() {
        try {
            await appWindow.close();
        } catch (error) {
            showToast(String(error), "error");
        }
    }

    async function handleTitlebarMouseDown(event: MouseEvent<HTMLDivElement>) {
        if (event.button !== 0) {
            return;
        }

        const target = event.target as HTMLElement | null;
        if (
            target?.closest(
                "button, a, input, textarea, select, [role='button'], [data-no-drag='true']",
            )
        ) {
            return;
        }

        try {
            await appWindow.startDragging();
        } catch (error) {
            showToast(String(error), "error");
        }
    }

    return (
        <main className="relative h-screen overflow-hidden bg-background text-foreground">
            <Toaster
                className="zprt-toaster"
                theme="dark"
                richColors
                position="top-right"
                duration={3800}
                offset={48}
                closeButton
            />
            {showEasterEgg && (
                <div className="pointer-events-none fixed inset-0 z-[5000] bg-black">
                    <img
                        src={coolImage}
                        alt=""
                        className="h-screen w-screen object-fill"
                    />
                </div>
            )}

            <div className="flex h-full min-h-0 flex-col">
                <header className="shrink-0 border-b border-border">
                    <div
                        data-tauri-drag-region
                        onMouseDown={(event) =>
                            void handleTitlebarMouseDown(event)
                        }
                        className="flex h-10 items-center pl-3"
                    >
                        <button
                            type="button"
                            onClick={handleTitleClick}
                            className="cursor-pointer select-none text-sm font-semibold tracking-tight"
                        >
                            {t("app.windowName")}
                        </button>
                        <div className="ml-3 select-none rounded-md border border-border bg-card px-2 py-0.5 text-xs text-muted-foreground">
                            {t("status.label")}:{" "}
                            <span
                                className={
                                    state.isRunning
                                        ? "font-medium text-emerald-400"
                                        : "text-foreground"
                                }
                            >
                                {statusLabel}
                            </span>
                        </div>
                        <div className="ml-auto flex h-full items-stretch">
                            <button
                                type="button"
                                onClick={() => void minimizeWindow()}
                                className="inline-flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                aria-label={t("app.minimize")}
                                title={t("app.minimize")}
                            >
                                <MinusIcon className="size-4" />
                            </button>
                            <button
                                type="button"
                                onClick={() => void closeWindow()}
                                className="inline-flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-red-500 hover:text-white"
                                aria-label={t("app.close")}
                                title={t("app.close")}
                            >
                                <XIcon className="size-4" />
                            </button>
                        </div>
                    </div>
                </header>

                <Tabs
                    value={tab}
                    onValueChange={(value) => setTab(value as Tab)}
                    className="flex min-h-0 flex-1 flex-col"
                >
                    <TabsList
                        variant="line"
                        className="mx-4 my-3 w-auto shrink-0 justify-start"
                    >
                        <TabsTrigger
                            value="control"
                            disabled={
                                busy || savingLists || !hasInstalledVersions
                            }
                        >
                            {t("tabs.control")}
                        </TabsTrigger>
                        <TabsTrigger
                            value="lists"
                            disabled={
                                busy || savingLists || !hasInstalledVersions
                            }
                        >
                            {t("tabs.lists")}
                        </TabsTrigger>
                        <TabsTrigger
                            value="versions"
                            disabled={busy || savingLists}
                            className={state.updateAvailable ? "px-2" : ""}
                        >
                            <span className="inline-flex items-center gap-2">
                                {state.updateAvailable && (
                                    <span className="size-2 rounded-full bg-[#fcce03]" />
                                )}
                                {t("tabs.versions")}
                            </span>
                        </TabsTrigger>
                    </TabsList>

                    <div className="min-h-0 flex-1 border-t border-border bg-card">
                        <TabsContent value="control" className="m-0 h-full">
                            <ScrollArea className="h-full">
                                <div className="space-y-4 p-4">
                                    <CardDescription>
                                        {t("control.description")}
                                    </CardDescription>
                                    <div className="space-y-2">
                                        <Label>{t("control.strategy")}</Label>
                                        <Popover
                                            open={strategyPickerOpen}
                                            onOpenChange={setStrategyPickerOpen}
                                        >
                                            <PopoverTrigger asChild>
                                                <Button
                                                    variant="outline"
                                                    role="combobox"
                                                    aria-expanded={
                                                        strategyPickerOpen
                                                    }
                                                    disabled={
                                                        busy ||
                                                        state.strategies
                                                            .length === 0
                                                    }
                                                    className="w-full justify-between"
                                                >
                                                    <span className="truncate text-left">
                                                        {state.selectedStrategy
                                                            ? formatStrategyName(
                                                                  state.selectedStrategy,
                                                              )
                                                            : t(
                                                                  "control.selectStrategy",
                                                              )}
                                                    </span>
                                                    <CaretUpDownIcon className="ml-2 size-4 shrink-0 opacity-60" />
                                                </Button>
                                            </PopoverTrigger>
                                            <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0">
                                                <Command>
                                                    <CommandInput
                                                        placeholder={t(
                                                            "control.searchStrategy",
                                                        )}
                                                    />
                                                    <CommandList>
                                                        <CommandEmpty>
                                                            {t(
                                                                "control.noStrategyFound",
                                                            )}
                                                        </CommandEmpty>
                                                        <CommandGroup>
                                                            {state.strategies.map(
                                                                (strategy) => (
                                                                    <CommandItem
                                                                        key={
                                                                            strategy
                                                                        }
                                                                        value={
                                                                            strategy
                                                                        }
                                                                        data-checked={
                                                                            state.selectedStrategy ===
                                                                            strategy
                                                                                ? "true"
                                                                                : "false"
                                                                        }
                                                                        onSelect={(
                                                                            value,
                                                                        ) => {
                                                                            if (
                                                                                !value ||
                                                                                value ===
                                                                                    state.selectedStrategy ||
                                                                                busy
                                                                            ) {
                                                                                setStrategyPickerOpen(
                                                                                    false,
                                                                                );
                                                                                return;
                                                                            }
                                                                            setStrategyPickerOpen(
                                                                                false,
                                                                            );
                                                                            void runAction(
                                                                                () =>
                                                                                    invoke(
                                                                                        "select_strategy",
                                                                                        {
                                                                                            strategy:
                                                                                                value,
                                                                                        },
                                                                                    ).then(
                                                                                        () =>
                                                                                            undefined,
                                                                                    ),
                                                                            );
                                                                        }}
                                                                    >
                                                                        <span className="truncate">
                                                                            {formatStrategyName(
                                                                                strategy,
                                                                            )}
                                                                        </span>
                                                                    </CommandItem>
                                                                ),
                                                            )}
                                                        </CommandGroup>
                                                    </CommandList>
                                                </Command>
                                            </PopoverContent>
                                        </Popover>
                                    </div>

                                    <div className="flex flex-wrap gap-2">
                                        <Button
                                            disabled={
                                                busy ||
                                                !state.selectedStrategy ||
                                                !state.activeVersion
                                            }
                                            onClick={() =>
                                                runAction(
                                                    async () => {
                                                        if (state.isRunning) {
                                                            await invoke(
                                                                "stop_bypass",
                                                            );
                                                        }
                                                        await invoke(
                                                            "start_bypass",
                                                        );
                                                    },
                                                    state.isRunning
                                                        ? t(
                                                              "toasts.bypassRestarted",
                                                          )
                                                        : t(
                                                              "toasts.bypassStarted",
                                                          ),
                                                )
                                            }
                                        >
                                            {state.isRunning
                                                ? t("control.restart")
                                                : t("control.start")}
                                        </Button>
                                        {state.isRunning && (
                                            <Button
                                                variant="secondary"
                                                disabled={busy}
                                                onClick={() =>
                                                    runAction(
                                                        () =>
                                                            invoke(
                                                                "stop_bypass",
                                                            ).then(
                                                                () => undefined,
                                                            ),
                                                        t(
                                                            "toasts.bypassStopped",
                                                        ),
                                                    )
                                                }
                                            >
                                                {t("control.stop")}
                                            </Button>
                                        )}
                                    </div>

                                    <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2">
                                        <div className="space-y-1">
                                            <Label htmlFor="autostart">
                                                {t("control.autostart")}
                                            </Label>
                                        </div>
                                        <Switch
                                            id="autostart"
                                            checked={state.autostartEnabled}
                                            disabled={busy}
                                            onCheckedChange={(checked) =>
                                                runAction(
                                                    () =>
                                                        invoke(
                                                            "set_autostart",
                                                            {
                                                                enabled:
                                                                    checked,
                                                            },
                                                        ).then(() => undefined),
                                                    checked
                                                        ? t(
                                                              "toasts.autostartOn",
                                                          )
                                                        : t(
                                                              "toasts.autostartOff",
                                                          ),
                                                )
                                            }
                                        />
                                    </div>

                                    <div className="flex flex-wrap gap-2">
                                        <Button
                                            variant="outline"
                                            disabled={
                                                busy || !state.activeVersion
                                            }
                                            onClick={() =>
                                                runAction(() =>
                                                    invoke(
                                                        "open_service_bat",
                                                    ).then(() => undefined),
                                                )
                                            }
                                        >
                                            {t("control.openService")}
                                        </Button>
                                        <Button
                                            variant="outline"
                                            disabled={
                                                busy || !state.activeVersion
                                            }
                                            onClick={() =>
                                                runAction(() =>
                                                    invoke(
                                                        "open_active_version_folder",
                                                    ).then(() => undefined),
                                                )
                                            }
                                        >
                                            {t("control.openBypassFolder", {
                                                version:
                                                    state.activeVersion ?? "-",
                                            })}
                                        </Button>
                                    </div>
                                </div>
                            </ScrollArea>
                        </TabsContent>

                        <TabsContent value="lists" className="m-0 h-full">
                            <ScrollArea className="h-full">
                                <div className="space-y-4 p-4">
                                    <CardDescription>
                                        {t("lists.description")}
                                    </CardDescription>
                                    <div className="space-y-2">
                                        <Label>{t("lists.listLabel")}</Label>
                                        <Select
                                            value={selectedListKey}
                                            onValueChange={(value) =>
                                                setSelectedListKey(
                                                    value as UserListKey,
                                                )
                                            }
                                            disabled={busy || savingLists}
                                        >
                                            <SelectTrigger className="w-full">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="general">
                                                    {t("lists.general")}
                                                </SelectItem>
                                                <SelectItem value="excludeDomains">
                                                    {t("lists.excludeDomains")}
                                                </SelectItem>
                                                <SelectItem value="excludeIps">
                                                    {t("lists.excludeIps")}
                                                </SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>

                                    <Textarea
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
                                        placeholder={
                                            selectedListKey === "general"
                                                ? t(
                                                      "lists.placeholders.general",
                                                  )
                                                : selectedListKey ===
                                                    "excludeDomains"
                                                  ? t(
                                                        "lists.placeholders.excludeDomains",
                                                    )
                                                  : t(
                                                        "lists.placeholders.excludeIps",
                                                    )
                                        }
                                        className="zprt-lists-textarea h-[260px] resize-none font-mono text-sm"
                                    />

                                    <Button
                                        disabled={
                                            savingLists ||
                                            busy ||
                                            !selectedListDirty
                                        }
                                        onClick={() =>
                                            void saveSelectedList(true)
                                        }
                                    >
                                        {t("lists.save")}
                                    </Button>
                                </div>
                            </ScrollArea>
                        </TabsContent>

                        <TabsContent value="versions" className="m-0 h-full">
                            <ScrollArea className="h-full">
                                <div className="space-y-4 p-4">
                                    <CardDescription>
                                        {t("versions.description")}
                                    </CardDescription>
                                    <div className="grid grid-cols-2 gap-2">
                                        <div className="rounded-lg border border-border bg-muted/20 p-3">
                                            <div className="text-xs uppercase tracking-wide text-muted-foreground">
                                                {t("versions.current")}
                                            </div>
                                            <div className="mt-1 flex items-center justify-between gap-2">
                                                <div className="truncate pr-1 text-base font-semibold">
                                                    {state.activeVersion ??
                                                        t("versions.none")}
                                                </div>
                                                <Button
                                                    variant="ghost"
                                                    size="xs"
                                                    className="shrink-0"
                                                    disabled={
                                                        busy ||
                                                        !state.activeVersion
                                                    }
                                                    onClick={() =>
                                                        invoke(
                                                            "open_release_info_for_version",
                                                            {
                                                                version:
                                                                    state.activeVersion,
                                                            },
                                                        ).catch((error) =>
                                                            showToast(
                                                                String(error),
                                                                "error",
                                                            ),
                                                        )
                                                    }
                                                >
                                                    <ArrowSquareOutIcon className="size-3.5" />
                                                    {t("versions.releaseInfo")}
                                                </Button>
                                            </div>
                                        </div>
                                        <div
                                            className={
                                                state.updateAvailable
                                                    ? "rounded-lg border border-amber-500/60 bg-amber-500/10 p-3"
                                                    : "rounded-lg border border-border bg-muted/20 p-3"
                                            }
                                        >
                                            <div className="text-xs uppercase tracking-wide text-muted-foreground">
                                                {t("versions.latest")}
                                            </div>
                                            <div className="mt-1 flex items-center justify-between gap-2">
                                                <div className="truncate pr-1 text-base font-semibold">
                                                    {state.latestVersion ??
                                                        t("versions.unknown")}
                                                </div>
                                                <Button
                                                    variant="ghost"
                                                    size="xs"
                                                    className="shrink-0"
                                                    disabled={
                                                        busy ||
                                                        !state.latestReleaseUrl
                                                    }
                                                    onClick={() =>
                                                        state.latestReleaseUrl
                                                            ? invoke(
                                                                  "open_external_url",
                                                                  {
                                                                      url: state.latestReleaseUrl,
                                                                  },
                                                              ).catch((error) =>
                                                                  showToast(
                                                                      String(
                                                                          error,
                                                                      ),
                                                                      "error",
                                                                  ),
                                                              )
                                                            : undefined
                                                    }
                                                >
                                                    <ArrowSquareOutIcon className="size-3.5" />
                                                    {t("versions.releaseInfo")}
                                                </Button>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="flex flex-wrap gap-2">
                                        {(state.updateAvailable ||
                                            !hasInstalledVersions) && (
                                            <Button
                                                disabled={busy}
                                                onClick={() =>
                                                    runAction(
                                                        () =>
                                                            invoke(
                                                                "install_latest",
                                                            ).then(
                                                                () => undefined,
                                                            ),
                                                        hasInstalledVersions
                                                            ? t(
                                                                  "toasts.latestVersionInstalled",
                                                              )
                                                            : t(
                                                                  "toasts.versionInstalled",
                                                              ),
                                                    )
                                                }
                                            >
                                                {hasInstalledVersions
                                                    ? t("versions.update")
                                                    : t("versions.install")}
                                            </Button>
                                        )}
                                        <Button
                                            variant="outline"
                                            disabled={busy}
                                            onClick={checkUpdatesAction}
                                        >
                                            {t("versions.checkUpdates")}
                                        </Button>
                                    </div>

                                    <div className="space-y-2">
                                        <Label>
                                            {t("versions.versionSelectLabel")}
                                        </Label>
                                        <Select
                                            value={
                                                state.activeVersion ?? undefined
                                            }
                                            onValueChange={(value) =>
                                                runAction(
                                                    () =>
                                                        invoke(
                                                            "switch_active_version",
                                                            {
                                                                version: value,
                                                            },
                                                        ).then(() => undefined),
                                                    t(
                                                        "toasts.currentVersionChanged",
                                                    ),
                                                )
                                            }
                                            disabled={
                                                busy ||
                                                state.installedVersions
                                                    .length === 0
                                            }
                                        >
                                            <SelectTrigger className="w-full">
                                                <SelectValue
                                                    placeholder={t(
                                                        "versions.selectVersion",
                                                    )}
                                                />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {state.installedVersions.map(
                                                    (version) => (
                                                        <SelectItem
                                                            key={version}
                                                            value={version}
                                                        >
                                                            {version}
                                                        </SelectItem>
                                                    ),
                                                )}
                                            </SelectContent>
                                        </Select>
                                    </div>

                                    <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2">
                                        <Label htmlFor="notify-updates">
                                            {t("versions.notify")}
                                        </Label>
                                        <Switch
                                            id="notify-updates"
                                            checked={
                                                state.notifyUpdateAvailable
                                            }
                                            disabled={busy}
                                            onCheckedChange={(checked) =>
                                                runAction(
                                                    () =>
                                                        invoke(
                                                            "set_update_notifications_enabled",
                                                            {
                                                                enabled:
                                                                    checked,
                                                            },
                                                        ).then(() => undefined),
                                                    checked
                                                        ? t(
                                                              "toasts.notificationsOn",
                                                          )
                                                        : t(
                                                              "toasts.notificationsOff",
                                                          ),
                                                )
                                            }
                                        />
                                    </div>
                                </div>
                            </ScrollArea>
                        </TabsContent>
                    </div>
                </Tabs>
            </div>
        </main>
    );
}

export default function App() {
    if (window.location.hash === "#update-toast") {
        return <UpdateToastView />;
    }
    return <MainApp />;
}
