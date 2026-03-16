import React, { useState, useEffect, useRef, useCallback } from "react";
import { Search, Loader2, Globe } from "lucide-react";

interface AddressBarProps {
  currentUrl: string; // 来自 Main 进程的真实 URL
  pageTitle?: string;
  isLoading: boolean;
  favicon?: string;
  onNavigate: (url: string) => void;
}

const SEARCH_ENGINES: Array<{
  hosts: string[];
  queryKeys: string[];
  paths?: string[];
}> = [
  { hosts: ["google."], queryKeys: ["q"], paths: ["/search"] },
  { hosts: ["bing.com"], queryKeys: ["q"], paths: ["/search"] },
  { hosts: ["duckduckgo.com"], queryKeys: ["q"] },
  { hosts: ["yahoo."], queryKeys: ["p"] },
  { hosts: ["baidu.com"], queryKeys: ["wd", "word"], paths: ["/s"] },
  { hosts: ["sogou.com"], queryKeys: ["query"], paths: ["/web"] },
  { hosts: ["so.com"], queryKeys: ["q"], paths: ["/s"] },
  { hosts: ["yandex."], queryKeys: ["text"], paths: ["/search"] },
];

const formatDisplayUrl = (raw: string, pageTitle?: string) => {
  if (!raw) return "";
  if (raw.startsWith("report://")) {
    if (pageTitle && pageTitle.trim().length > 0) {
      return `report / ${pageTitle.trim()}`;
    }
    return raw;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch (e) {
    return raw;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return raw;
  }

  const hostname = url.hostname.replace(/^www\./, "");
  const pathname = url.pathname || "/";

  for (const engine of SEARCH_ENGINES) {
    const hostMatch = engine.hosts.some((host) => hostname.includes(host));
    if (!hostMatch) continue;
    if (engine.paths && !engine.paths.includes(pathname)) continue;
    for (const key of engine.queryKeys) {
      const value = url.searchParams.get(key);
      if (value) {
        return `${hostname} / ${value.replace(/\+/g, " ")}`;
      }
    }
  }

  if (pageTitle && pageTitle.trim().length > 0) {
    let title = pageTitle.trim();
    const separators = [" - ", " | ", " — ", " · "];
    for (const sep of separators) {
      const idx = title.indexOf(sep);
      if (idx > 0) {
        title = title.slice(0, idx).trim();
        break;
      }
    }
    if (title.toLowerCase() === hostname.toLowerCase()) return hostname;
    return `${hostname} / ${title}`;
  }

  return raw;
};

export function AddressBar({
  currentUrl,
  pageTitle,
  isLoading,
  favicon,
  onNavigate,
}: AddressBarProps) {
  // 内部 input 值
  const [inputValue, setInputValue] = useState(currentUrl);
  const [isFocused, setIsFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fallbackIcon =
    'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">' +
    '<rect width="16" height="16" rx="3" fill="%23d9d9d0"/></svg>';
  const selectAddressValue = useCallback(() => {
    window.requestAnimationFrame(() => {
      inputRef.current?.select();
    });
  }, []);

  // 当外部 URL 变化且用户未聚焦时，同步 URL
  useEffect(() => {
    if (!isFocused) {
      // 优化显示：去掉 http:// 或 trailing slash
      // 或者保持原样，看个人喜好
      setInputValue(currentUrl || "");
    }
  }, [currentUrl, isFocused]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim()) return;

    if (
      currentUrl.startsWith("report://") &&
      inputValue.trim() === currentUrl
    ) {
      return;
    }

    // ... 原有的 URL 处理逻辑 ...
    let navigateUrl = inputValue.trim();
    if (
      !navigateUrl.startsWith("http://") &&
      !navigateUrl.startsWith("https://")
    ) {
      // 如果不是完整 URL，尝试添加 https://
      if (navigateUrl.includes(".") && !navigateUrl.includes(" ")) {
        navigateUrl = `https://${navigateUrl}`;
      } else {
        // 否则作为搜索查询
        navigateUrl = `https://www.google.com/search?q=${encodeURIComponent(navigateUrl)}`;
      }
    }

    onNavigate(navigateUrl);
    inputRef.current?.blur(); // 提交后失焦
  };

  useEffect(() => {
    // 监听键盘快捷键
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "l") {
        e.preventDefault();
        inputRef.current?.focus();
        selectAddressValue();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectAddressValue]);

  useEffect(() => {
    const handleContentFocus = () => {
      if (document.activeElement === inputRef.current) {
        inputRef.current?.blur();
      }
    };

    const ipc = window.electron?.ipcRenderer;
    if (ipc?.on) {
      ipc.on("content-focus", handleContentFocus);
      return () => {
        ipc.removeAllListeners?.("content-focus");
      };
    }
  }, []);

  return (
    <form onSubmit={handleSubmit} className="relative">
      <div
        className={`group relative flex items-center overflow-hidden rounded-[16px] border transition-all duration-200 ${
          isFocused
            ? "border-[color:var(--field-border-strong)] bg-[var(--field-bg-focus)]"
            : "border-[color:var(--field-border)] bg-[var(--field-bg)] hover:border-[color:var(--border-strong)] hover:bg-[var(--field-bg-hover)]"
        }`}
        style={{
          boxShadow: isFocused
            ? "0 0 0 3px var(--field-focus-ring), var(--shadow-soft)"
            : "var(--shadow-soft)",
        }}
      >
        {isLoading ? (
          <div
            className="absolute inset-x-3.5 top-0 h-[2px] rounded-full opacity-90"
            style={{
              background:
                "linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--theme-accent) 18%, transparent) 18%, color-mix(in srgb, var(--theme-accent) 72%, white) 50%, color-mix(in srgb, var(--theme-accent) 18%, transparent) 82%, transparent 100%)",
            }}
          />
        ) : null}

        <div className="pointer-events-none absolute left-2.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/5 dark:bg-white/5">
          {favicon ? (
            <img
              src={favicon}
              alt=""
              className="h-3.5 w-3.5 rounded-[4px] object-contain"
              onError={(e) => {
                e.currentTarget.src = fallbackIcon;
              }}
            />
          ) : (
            <Globe size={14} className="text-[color:var(--text-secondary)]" />
          )}
        </div>

        <input
          ref={inputRef}
          type="text"
          value={
            isFocused ? inputValue : formatDisplayUrl(currentUrl, pageTitle)
          }
          onChange={(e) => setInputValue(e.target.value)}
          onMouseDown={(e) => {
            if (document.activeElement === inputRef.current) return;
            e.preventDefault();
            inputRef.current?.focus();
            selectAddressValue();
          }}
          onFocus={() => {
            setIsFocused(true);
            selectAddressValue();
          }}
          onBlur={() => setIsFocused(false)}
          placeholder="Search or enter a URL"
          className="address-bar-input h-9 w-full bg-transparent pl-10 pr-10 text-[13px] font-medium tracking-[0.01em] text-[color:var(--text-primary)] outline-none placeholder:text-[color:var(--text-tertiary)]"
        />

        <div className="absolute right-1.5 flex h-7 w-7 items-center justify-center rounded-full text-[color:var(--text-secondary)]">
          {isLoading ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Search size={13} className="opacity-70" />
          )}
        </div>
      </div>
    </form>
  );
}
