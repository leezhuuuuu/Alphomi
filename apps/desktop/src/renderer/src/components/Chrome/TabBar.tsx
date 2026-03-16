import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { X, Plus, Pin, Globe } from "lucide-react";
import { Tab } from "../../types";

interface TabBarProps {
  tabs: Tab[];
  onTabClick: (id: number) => void;
  onTabClose: (id: number) => void;
  onNewTab: () => void;
}

export function TabBar({
  tabs,
  onTabClick,
  onTabClose,
  onNewTab,
}: TabBarProps) {
  const fallbackIcon =
    'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">' +
    '<rect width="16" height="16" rx="3" fill="%23d9d9d0"/></svg>';
  const [orderedTabs, setOrderedTabs] = useState<Tab[]>(tabs);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const tabRefs = useRef(new Map<number, HTMLDivElement | null>());
  const prevRectsRef = useRef(new Map<number, DOMRect>());

  useEffect(() => {
    setOrderedTabs((prev) => {
      const next: Tab[] = [];
      const seen = new Set<number>();
      const currentMap = new Map(tabs.map((t) => [t.id, t]));

      prev.forEach((t) => {
        const current = currentMap.get(t.id);
        if (current) {
          next.push(current);
          seen.add(current.id);
        }
      });

      tabs.forEach((t) => {
        if (!seen.has(t.id)) {
          next.push(t);
        }
      });

      return next;
    });
  }, [tabs]);

  useLayoutEffect(() => {
    const nextRects = new Map<number, DOMRect>();
    let widthChanged = false;
    orderedTabs.forEach((t) => {
      const el = tabRefs.current.get(t.id);
      if (!el) return;
      const rect = el.getBoundingClientRect();
      nextRects.set(t.id, rect);
      const prev = prevRectsRef.current.get(t.id);
      if (prev && Math.abs(prev.width - rect.width) > 1) {
        widthChanged = true;
      }
    });

    const countChanged = prevRectsRef.current.size !== nextRects.size;

    orderedTabs.forEach((t) => {
      const el = tabRefs.current.get(t.id);
      if (!el) return;
      const rect = nextRects.get(t.id);
      if (!rect) return;
      const prev = prevRectsRef.current.get(t.id);
      if (prev && draggingId === null && !widthChanged && !countChanged) {
        const dx = prev.left - rect.left;
        if (dx !== 0) {
          el.animate(
            [
              { transform: `translate(${dx}px, 0)` },
              { transform: "translate(0, 0)" },
            ],
            { duration: 180, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
          );
        }
      }
    });
    prevRectsRef.current = nextRects;
  }, [orderedTabs, draggingId]);

  const handleDragStart =
    (id: number) => (event: React.DragEvent<HTMLDivElement>) => {
      setDraggingId(id);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(id));
    };

  const lastOverIdRef = useRef<number | null>(null);

  const handleDragOver =
    (id: number) => (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (draggingId === null || draggingId === id) return;
      if (lastOverIdRef.current === id) return;
      lastOverIdRef.current = id;
      setOrderedTabs((prev) => {
        const from = prev.findIndex((t) => t.id === draggingId);
        const to = prev.findIndex((t) => t.id === id);
        if (from < 0 || to < 0 || from === to) return prev;
        const next = [...prev];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        return next;
      });
    };

  const handleDragEnd = () => {
    setDraggingId(null);
    lastOverIdRef.current = null;
  };

  return (
    <div className="draggable flex h-[38px] items-center px-1">
      <div className="flex-1 min-w-0 overflow-x-auto overflow-y-hidden scrollbar-hide">
        <div className="flex items-center gap-0.5">
          {orderedTabs.map((tab, index) => (
            <React.Fragment key={tab.id}>
              <div
                ref={(el) => tabRefs.current.set(tab.id, el)}
                onClick={() => onTabClick(tab.id)}
                draggable
                onDragStart={handleDragStart(tab.id)}
                onDragOver={handleDragOver(tab.id)}
                onDragEnd={handleDragEnd}
                className={`group relative flex h-[34px] cursor-default items-center overflow-hidden rounded-[12px] border text-[12px] transition-all duration-200 no-drag ${
                  tab.isPinned
                    ? "flex-[0_0_62px] max-w-[108px] px-2"
                    : "flex-[1_1_132px] min-w-[32px] max-w-[184px] px-3"
                } ${
                  tab.active
                    ? "border-[color:var(--border-strong)] bg-[var(--tab-active-bg)] text-[color:var(--text-primary)]"
                    : "border-transparent bg-[var(--tab-idle-bg)] text-[color:var(--text-secondary)] hover:border-[color:var(--border-soft)] hover:bg-[var(--shell-surface-strong)] hover:text-[color:var(--text-primary)]"
                } ${draggingId === tab.id ? "opacity-60" : ""}`}
              >
                <div
                  className={`absolute inset-x-1.5 top-0 h-px rounded-full transition-opacity ${
                    tab.active
                      ? "opacity-100"
                      : "opacity-0 group-hover:opacity-60"
                  }`}
                  style={{
                    background:
                      "linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--theme-accent) 46%, white) 20%, color-mix(in srgb, var(--theme-accent) 80%, white) 50%, color-mix(in srgb, var(--theme-accent) 46%, white) 80%, transparent 100%)",
                  }}
                />
                <div className="mr-1.5 flex h-4 w-4 items-center justify-center">
                  {tab.favicon ? (
                    <img
                      src={tab.favicon}
                      alt=""
                      className="h-4 w-4 rounded-[3px] object-contain"
                      onError={(e) => {
                        e.currentTarget.src = fallbackIcon;
                      }}
                    />
                  ) : (
                    <Globe
                      size={14}
                      className="text-[color:var(--text-secondary)]"
                    />
                  )}
                </div>
                {tab.isPinned ? (
                  <Pin
                    size={12}
                    className="mr-1 text-[color:var(--text-tertiary)]"
                  />
                ) : null}
                <span className="mr-1 flex-1 min-w-0 truncate font-medium">
                  {tab.title || "New Tab"}
                </span>
                <div className="w-4 overflow-hidden">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onTabClose(tab.id);
                    }}
                    className={`rounded-md p-0.5 transition-all duration-150 hover:bg-[var(--chrome-control-hover)] ${
                      tab.active
                        ? "opacity-60 hover:opacity-100"
                        : "opacity-0 group-hover:opacity-100"
                    }`}
                  >
                    <X size={12} />
                  </button>
                </div>
              </div>
              {index < orderedTabs.length - 1 && (
                <div
                  className={`h-4 w-px ${
                    tab.active || orderedTabs[index + 1].active
                      ? "opacity-0"
                      : "opacity-80"
                  }`}
                  style={{ background: "var(--tab-divider)" }}
                />
              )}
            </React.Fragment>
          ))}
          <div className="sticky right-2 flex items-center bg-transparent pl-1 no-drag">
            <button
              onClick={onNewTab}
              className="flex h-[34px] w-[34px] items-center justify-center rounded-[11px] border border-transparent bg-[var(--tab-idle-bg)] text-[color:var(--text-secondary)] transition-all duration-200 hover:border-[color:var(--border-soft)] hover:bg-[var(--shell-surface-strong)] hover:text-[color:var(--text-primary)]"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>
      </div>
      <div className="draggable h-[38px] w-10" />
    </div>
  );
}
