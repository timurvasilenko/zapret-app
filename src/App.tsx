import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { CaretUpDownIcon } from "@phosphor-icons/react";
import { Toaster, toast } from "sonner";
import { useTranslation } from "react-i18next";
import coolImage from "./img/cool.jpg";
import { Button } from "@/components/ui/button";
import {
  CardDescription,
  CardTitle,
} from "@/components/ui/card";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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

  useEffect(() => {
    const win = getCurrentWebviewWindow();
    let unlisten: (() => void) | undefined;

    win
      .listen<string>("update-toast-message", (event) => {
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
      <div className="h-full w-full rounded-xl border border-[#fcce03b3] bg-[#09111cf5] p-4 shadow-2xl">
        <div className="text-sm font-bold text-[#fcce03]">ZPRT App</div>
        <div className="mt-2 text-sm leading-relaxed text-slate-100">{text}</div>
      </div>
    </div>
  );
}

function MainApp() {
  const { t } = useTranslation();
  const [state, setState] = useState<AppState>(emptyState);
  const [tab, setTab] = useState<Tab>("control");
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

  const hasInstalledVersions = state.installedVersions.length > 0;
  const selectedListValue = getListValue(state, selectedListKey);
  const selectedListDirty = selectedListValue !== savedLists[selectedListKey];

  const statusLabel = useMemo(
    () => (state.isRunning ? t("status.running") : t("status.stopped")),
    [state.isRunning, t]
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
  }

  function setListValue(key: UserListKey, value: string) {
    setState((prev) => {
      if (key === "general") return { ...prev, listGeneralUser: value };
      if (key === "excludeDomains") return { ...prev, listExcludeUser: value };
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
      if (next.updateAvailable) {
        showToast(t("toasts.updateAvailable"), "info");
      } else {
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
    if (!startupUpdateToastShown.current && state.updateAvailable) {
      startupUpdateToastShown.current = true;
      showToast(t("toasts.newUtilityVersion"), "info");
    }
  }, [state.updateAvailable, t]);

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
    <main className="relative h-screen overflow-hidden bg-background text-foreground">
      <Toaster theme="dark" richColors position="top-right" duration={3800} />
      {showEasterEgg && (
        <div className="pointer-events-none fixed inset-0 z-[5000] bg-black">
          <img src={coolImage} alt="" className="h-screen w-screen object-fill" />
        </div>
      )}

      <div className="flex h-full min-h-0 flex-col">
        <header className="shrink-0 border-b border-border px-4 py-3">
          <div className="flex items-center justify-between">
          <h1
            onClick={handleTitleClick}
            className="cursor-pointer select-none text-2xl font-semibold tracking-tight"
          >
            ZPRT App
          </h1>
          <div className="rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground">
            {t("status.label")}:{" "}
            <span
              className={
                state.isRunning ? "font-medium text-emerald-400" : "text-foreground"
              }
            >
              {statusLabel}
            </span>
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
              disabled={busy || savingLists || !hasInstalledVersions}
            >
              {t("tabs.control")}
            </TabsTrigger>
            <TabsTrigger
              value="lists"
              disabled={busy || savingLists || !hasInstalledVersions}
            >
              {t("tabs.lists")}
            </TabsTrigger>
            <TabsTrigger
              value="versions"
              disabled={busy || savingLists}
              className={
                state.updateAvailable
                  ? "rounded-md border border-[#fcce03] px-2 data-active:border-[#fcce03]"
                  : ""
              }
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
                  <div className="space-y-1">
                    <CardTitle>{t("control.title")}</CardTitle>
                    <CardDescription>{t("control.description")}</CardDescription>
                  </div>
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
                        aria-expanded={strategyPickerOpen}
                        disabled={busy || state.strategies.length === 0}
                        className="w-full justify-between"
                      >
                        <span className="truncate text-left">
                          {state.selectedStrategy
                            ? formatStrategyName(state.selectedStrategy)
                            : t("control.selectStrategy")}
                        </span>
                        <CaretUpDownIcon className="ml-2 size-4 shrink-0 opacity-60" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0">
                      <Command>
                        <CommandInput placeholder={t("control.searchStrategy")} />
                        <CommandList>
                          <CommandEmpty>{t("control.noStrategyFound")}</CommandEmpty>
                          <CommandGroup>
                            {state.strategies.map((strategy) => (
                              <CommandItem
                                key={strategy}
                                value={strategy}
                                data-checked={
                                  state.selectedStrategy === strategy
                                    ? "true"
                                    : "false"
                                }
                                onSelect={(value) => {
                                  if (
                                    !value ||
                                    value === state.selectedStrategy ||
                                    busy
                                  ) {
                                    setStrategyPickerOpen(false);
                                    return;
                                  }
                                  setStrategyPickerOpen(false);
                                  void runAction(() =>
                                    invoke("select_strategy", {
                                      strategy: value,
                                    }).then(() => undefined),
                                  );
                                }}
                              >
                                <span className="truncate">
                                  {formatStrategyName(strategy)}
                                </span>
                              </CommandItem>
                            ))}
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
                            await invoke("stop_bypass");
                          }
                          await invoke("start_bypass");
                        },
                        state.isRunning
                          ? t("toasts.bypassRestarted")
                          : t("toasts.bypassStarted")
                      )
                    }
                  >
                    {state.isRunning ? t("control.restart") : t("control.start")}
                  </Button>
                  {state.isRunning && (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() =>
                        runAction(
                          () => invoke("stop_bypass").then(() => undefined),
                          t("toasts.bypassStopped")
                        )
                      }
                    >
                      {t("control.stop")}
                    </Button>
                  )}
                </div>

                <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2">
                  <div className="space-y-1">
                    <Label htmlFor="autostart">{t("control.autostart")}</Label>
                  </div>
                  <Switch
                    id="autostart"
                    checked={state.autostartEnabled}
                    disabled={busy}
                    onCheckedChange={(checked) =>
                      runAction(
                        () =>
                          invoke("set_autostart", {
                            enabled: checked,
                          }).then(() => undefined),
                        checked
                          ? t("toasts.autostartOn")
                          : t("toasts.autostartOff")
                      )
                    }
                  />
                </div>

                <Button
                  variant="outline"
                  disabled={busy || !state.activeVersion}
                  onClick={() =>
                    runAction(
                      () => invoke("open_service_bat").then(() => undefined),
                      t("toasts.serviceOpened")
                    )
                  }
                >
                  {t("control.openService")}
                </Button>
                </div>
              </ScrollArea>
            </TabsContent>

            <TabsContent value="lists" className="m-0 h-full">
              <ScrollArea className="h-full">
                <div className="space-y-4 p-4">
                  <div className="space-y-1">
                    <CardTitle>{t("lists.title")}</CardTitle>
                    <CardDescription>{t("lists.description")}</CardDescription>
                  </div>
                <div className="space-y-2">
                  <Label>{t("lists.listLabel")}</Label>
                  <Select
                    value={selectedListKey}
                    onValueChange={(value) =>
                      setSelectedListKey(value as UserListKey)
                    }
                    disabled={busy || savingLists}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="general">{t("lists.general")}</SelectItem>
                      <SelectItem value="excludeDomains">
                        {t("lists.excludeDomains")}
                      </SelectItem>
                      <SelectItem value="excludeIps">{t("lists.excludeIps")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <Textarea
                  value={selectedListValue}
                  onChange={(event) =>
                    setListValue(selectedListKey, event.target.value)
                  }
                  onBlur={() => {
                    if (selectedListDirty) {
                      void saveSelectedList(false);
                    }
                  }}
                  placeholder={
                    selectedListKey === "general"
                      ? t("lists.placeholders.general")
                      : selectedListKey === "excludeDomains"
                        ? t("lists.placeholders.excludeDomains")
                        : t("lists.placeholders.excludeIps")
                  }
                  className="min-h-[260px] font-mono text-sm"
                />

                <Button
                  disabled={savingLists || busy || !selectedListDirty}
                  onClick={() => void saveSelectedList(true)}
                >
                  {t("lists.save")}
                </Button>
                </div>
              </ScrollArea>
            </TabsContent>

            <TabsContent value="versions" className="m-0 h-full">
              <ScrollArea className="h-full">
                <div className="space-y-4 p-4">
                  <div className="space-y-1">
                    <CardTitle>{t("versions.title")}</CardTitle>
                    <CardDescription>{t("versions.description")}</CardDescription>
                  </div>
                <div className="grid gap-2 rounded-lg border border-border bg-muted/30 p-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">{t("versions.current")}:</span>
                    <span className="font-medium">
                      {state.activeVersion ?? t("versions.none")}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">{t("versions.latest")}:</span>
                    <span className="font-medium">
                      {state.latestVersion ?? t("versions.unknown")}
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {(state.updateAvailable || !hasInstalledVersions) && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        runAction(
                          () => invoke("install_latest").then(() => undefined),
                          hasInstalledVersions
                            ? t("toasts.latestVersionInstalled")
                            : t("toasts.versionInstalled")
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
                  <Label>{t("versions.versionSelectLabel")}</Label>
                  <Select
                    value={state.activeVersion ?? undefined}
                    onValueChange={(value) =>
                      runAction(
                        () =>
                          invoke("switch_active_version", {
                            version: value,
                          }).then(() => undefined),
                        t("toasts.currentVersionChanged")
                      )
                    }
                    disabled={busy || state.installedVersions.length === 0}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder={t("versions.selectVersion")} />
                    </SelectTrigger>
                    <SelectContent>
                      {state.installedVersions.map((version) => (
                        <SelectItem key={version} value={version}>
                          {version}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2">
                  <Label htmlFor="notify-updates">{t("versions.notify")}</Label>
                  <Switch
                    id="notify-updates"
                    checked={state.notifyUpdateAvailable}
                    disabled={busy}
                    onCheckedChange={(checked) =>
                      runAction(
                        () =>
                          invoke("set_update_notifications_enabled", {
                            enabled: checked,
                          }).then(() => undefined),
                        checked
                          ? t("toasts.notificationsOn")
                          : t("toasts.notificationsOff")
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
