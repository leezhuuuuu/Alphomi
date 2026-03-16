import React, { useEffect, useRef, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { AddressBar } from "./components/Chrome/AddressBar";
import { TabBar } from "./components/Chrome/TabBar";
import {
  RefreshCw,
  ArrowLeft,
  ArrowRight,
  X,
  MoreVertical,
  BrainCircuit,
} from "lucide-react";
import { Tab, NavigationState } from "./types";

export const SessionContext = React.createContext<string | null>(null);

type ThemeMode = "light" | "dark" | "system";

function resolveThemeMode(mode: ThemeMode): "light" | "dark" {
  if (
    mode === "system" &&
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }

  return mode === "dark" ? "dark" : "light";
}

function applyResolvedMode(mode: "light" | "dark") {
  document.documentElement.classList.toggle("dark", mode === "dark");
}

// 默认导航状态
const DEFAULT_NAV_STATE: NavigationState = {
  url: "",
  title: "",
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  favicon: "",
};

function App(): JSX.Element {
  const ASSISTANT_DEFAULT_MIN_WIDTH = 468;
  const BROWSER_MIN_WIDTH = 360;
  const [sessionId, setSessionId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const assistantPanelRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const [isAssistantOpen, setIsAssistantOpen] = useState(true);
  const [assistantWidth, setAssistantWidth] = useState(0.3);
  const [assistantMinWidth, setAssistantMinWidth] = useState(
    ASSISTANT_DEFAULT_MIN_WIDTH,
  );
  const [isResizing, setIsResizing] = useState(false);

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [navState, setNavState] = useState<NavigationState>(DEFAULT_NAV_STATE);
  const applyTheme = (color: string) => {
    document.documentElement.style.setProperty("--theme-accent", color);
    window.localStorage.setItem("ui-theme-accent", color);
  };

  useEffect(() => {
    const handleSessionReady = (_: unknown, id: string) => setSessionId(id);
    const handleTabsUpdate = (_: unknown, newTabs: Tab[]) => setTabs(newTabs);
    const handleActiveTabUpdate = (_: unknown, state: NavigationState) =>
      setNavState({ ...DEFAULT_NAV_STATE, ...state });
    const handleThemeSet = (_: unknown, color: string) => applyTheme(color);
    const handleModeSet = (_: unknown, mode: "light" | "dark") => {
      applyResolvedMode(mode);
    };
    const mediaQuery = window.matchMedia
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : null;
    const handleSystemChange = async () => {
      try {
        const settings = await window.api.getSettings();
        if (settings.themeMode === "system") {
          applyResolvedMode(resolveThemeMode("system"));
        }
      } catch {
        applyResolvedMode("light");
      }
    };

    window.electron.ipcRenderer.on("session-ready", handleSessionReady);

    // 监听 Tab 列表更新
    window.electron.ipcRenderer.on("tabs-update", handleTabsUpdate);

    // 监听当前激活 Tab 的详细状态 (URL, Back/Forward)
    window.electron.ipcRenderer.on("active-tab-update", handleActiveTabUpdate);

    window.electron.ipcRenderer.on("ui-theme-set", handleThemeSet);
    window.electron.ipcRenderer.on("ui-mode-set", handleModeSet);

    window.api
      .getSettings()
      .then((settings) => {
        applyResolvedMode(resolveThemeMode(settings.themeMode));
      })
      .catch(() => {
        applyResolvedMode("light");
      });

    mediaQuery?.addEventListener("change", handleSystemChange);

    return () => {
      window.electron.ipcRenderer.removeListener(
        "session-ready",
        handleSessionReady,
      );
      window.electron.ipcRenderer.removeListener(
        "tabs-update",
        handleTabsUpdate,
      );
      window.electron.ipcRenderer.removeListener(
        "active-tab-update",
        handleActiveTabUpdate,
      );
      window.electron.ipcRenderer.removeListener("ui-theme-set", handleThemeSet);
      window.electron.ipcRenderer.removeListener("ui-mode-set", handleModeSet);
      mediaQuery?.removeEventListener("change", handleSystemChange);
    };
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem("assistant-panel-open");
    if (saved !== null) {
      setIsAssistantOpen(saved === "true");
    }
  }, []);

  const toggleAssistantPanel = (next?: boolean) => {
    setIsAssistantOpen((prev) => {
      const value = typeof next === "boolean" ? next : !prev;
      localStorage.setItem("assistant-panel-open", String(value));
      return value;
    });
  };

  const handleResizeStart = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isAssistantOpen) return;
    e.preventDefault();
    setIsResizing(true);
    const startX = e.clientX;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const initialContainerWidth =
      contentRef.current?.getBoundingClientRect().width ?? 0;
    const initialPanelWidth =
      assistantPanelRef.current?.getBoundingClientRect().width ??
      assistantWidth * initialContainerWidth;

    const onMove = (event: MouseEvent) => {
      const container = contentRef.current;
      if (!container) return;
      const { width } = container.getBoundingClientRect();
      if (!width) return;
      const delta = startX - event.clientX;
      const next = (initialPanelWidth + delta) / width;
      const minRatio = Math.min(1, assistantMinWidth / width);
      const maxRatio = Math.max(minRatio, 1 - BROWSER_MIN_WIDTH / width);
      const clamped = Math.min(maxRatio, Math.max(minRatio, next));
      setAssistantWidth(clamped);
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      setIsResizing(false);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  useEffect(() => {
    const savedTheme = window.localStorage.getItem("ui-theme-accent");
    if (savedTheme) {
      document.documentElement.style.setProperty("--theme-accent", savedTheme);
    }
  }, []);

  useEffect(() => {
    // 监听容器大小变化，通过 IPC 通知主进程调整 BrowserView
    let rafId: number | null = null;
    const updateLayout = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        // 通知主进程，这是留给浏览器的区域大小和位置
        window.api.resizeView({
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
    };

    const scheduleLayout = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(updateLayout);
    };

    const observer = new ResizeObserver(scheduleLayout);
    if (containerRef.current) observer.observe(containerRef.current);

    window.addEventListener("resize", scheduleLayout);
    // 初始调用
    setTimeout(scheduleLayout, 100);

    return () => {
      window.removeEventListener("resize", scheduleLayout);
      observer.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, []);

  // Tab 操作
  const handleTabClick = (id: number) => window.api.tabSelect(id);
  const handleTabClose = (id: number) => window.api.tabClose(id);
  const handleNewTab = () => window.api.tabNew();
  const navButtonClass =
    "flex h-[30px] w-[30px] items-center justify-center rounded-[11px] border border-transparent text-[color:var(--text-secondary)] transition-all duration-200";
  const navButtonEnabledClass =
    "hover:border-[color:var(--border-soft)] hover:bg-[var(--chrome-control-hover)] hover:text-[color:var(--text-primary)]";
  const navButtonDisabledClass = "cursor-default opacity-40";
  const assistantToggleButtonClass = `${navButtonClass} no-drag ${
    isAssistantOpen
      ? "border-[color:var(--field-border-strong)] bg-[var(--field-focus-ring)] text-[color:var(--theme-accent)] hover:border-[color:var(--field-border-strong)] hover:bg-[var(--field-focus-ring)] hover:text-[color:var(--theme-accent)]"
      : navButtonEnabledClass
  }`;

  return (
    <SessionContext.Provider value={sessionId}>
      <div className="flex h-screen w-screen overflow-hidden text-[color:var(--text-primary)] transition-colors duration-300">
        <div className="flex flex-col flex-1 h-full min-w-0">
          <div className="relative z-20 flex items-end px-2.5 pt-1">
            <div className="w-16 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <TabBar
                tabs={tabs}
                onTabClick={handleTabClick}
                onTabClose={handleTabClose}
                onNewTab={handleNewTab}
              />
            </div>
          </div>

          <div className="relative z-0 flex-1 min-h-0 px-2.5 pb-2.5">
            <div
              className="flex h-full min-h-0 flex-col overflow-hidden rounded-tl-[22px] rounded-tr-[22px] rounded-br-[22px] rounded-bl-none border border-[color:var(--border-soft)] bg-[var(--shell-surface)] backdrop-blur-xl"
              style={{ boxShadow: "var(--shadow-lifted)" }}
            >
              <div className="no-drag z-20 flex h-[48px] items-center gap-2.5 border-b border-[color:var(--border-soft)] bg-[var(--shell-chrome)] px-2.5 transition-colors">
                <div
                  className="no-drag flex items-center gap-1 rounded-[14px] border border-[color:var(--border-soft)] bg-[var(--chrome-control-cluster)] p-[3px]"
                  style={{ boxShadow: "var(--shadow-soft)" }}
                >
                  <button
                    onClick={() => window.api.goBack()}
                    disabled={!navState.canGoBack}
                    className={`${navButtonClass} ${
                      navState.canGoBack
                        ? navButtonEnabledClass
                        : navButtonDisabledClass
                    }`}
                  >
                    <ArrowLeft size={16} />
                  </button>
                  <button
                    onClick={() => window.api.goForward()}
                    disabled={!navState.canGoForward}
                    className={`${navButtonClass} ${
                      navState.canGoForward
                        ? navButtonEnabledClass
                        : navButtonDisabledClass
                    }`}
                  >
                    <ArrowRight size={16} />
                  </button>

                  <button
                    onClick={() =>
                      navState.isLoading
                        ? window.api.stop()
                        : window.api.reload()
                    }
                    className={`${navButtonClass} ${navButtonEnabledClass}`}
                  >
                    {navState.isLoading ? (
                      <X size={14} />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                  </button>
                </div>

                <div className="mx-0.5 flex-1 min-w-[220px] no-drag">
                  <AddressBar
                    currentUrl={navState.url}
                    pageTitle={navState.title}
                    isLoading={navState.isLoading}
                    favicon={navState.favicon}
                    onNavigate={(url) => window.api.navigate(url)}
                  />
                </div>

                <button
                  onClick={() => toggleAssistantPanel()}
                  className={assistantToggleButtonClass}
                  aria-label={
                    isAssistantOpen
                      ? "Hide assistant panel"
                      : "Show assistant panel"
                  }
                  title={
                    isAssistantOpen
                      ? "Hide assistant panel"
                      : "Show assistant panel"
                  }
                >
                  <BrainCircuit size={16} />
                </button>

                <button
                  ref={menuButtonRef}
                  onClick={() => {
                    const rect = menuButtonRef.current?.getBoundingClientRect();
                    if (!rect) return;
                    window.api.openMenu({
                      x: Math.round(rect.x + window.screenX),
                      y: Math.round(rect.y + window.screenY),
                      width: Math.round(rect.width),
                      height: Math.round(rect.height),
                    });
                  }}
                  className={`${navButtonClass} ${navButtonEnabledClass} no-drag`}
                  aria-label="Open browser menu"
                >
                  <MoreVertical size={16} />
                </button>
              </div>

              <div ref={contentRef} className="flex flex-1 min-h-0 w-full">
                <div
                  ref={containerRef}
                  className="relative flex-1 transition-colors"
                  style={{ background: "var(--browser-surface)" }}
                />
                <div
                  onMouseDown={handleResizeStart}
                  className={`no-drag w-[8px] cursor-col-resize transition-colors ${
                    isAssistantOpen
                      ? "bg-transparent hover:bg-[var(--chrome-control-hover)]"
                      : "pointer-events-none"
                  }`}
                  style={{ opacity: isAssistantOpen ? 1 : 0 }}
                />
                <div
                  ref={assistantPanelRef}
                  className={`z-10 flex h-full flex-col overflow-hidden bg-[var(--assistant-surface)] ${
                    isResizing
                      ? ""
                      : "transition-[width,transform,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
                  }`}
                  style={{
                    width: isAssistantOpen
                      ? `max(${assistantMinWidth}px, ${assistantWidth * 100}%)`
                      : 0,
                    minWidth: isAssistantOpen ? assistantMinWidth : 0,
                    flexShrink: 0,
                    transform: isAssistantOpen
                      ? "translateX(0)"
                      : "translateX(16px)",
                    opacity: isAssistantOpen ? 1 : 0,
                    borderLeft: isAssistantOpen
                      ? "1px solid var(--border-soft)"
                      : "none",
                    boxShadow: isAssistantOpen ? "var(--shadow-soft)" : "none",
                    pointerEvents: isAssistantOpen ? "auto" : "none",
                  }}
                >
                  <Sidebar
                    sessionId={sessionId}
                    collapsed={!isAssistantOpen}
                    onMinWidthChange={setAssistantMinWidth}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </SessionContext.Provider>
  );
}
export default App;
