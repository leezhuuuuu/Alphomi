import React, { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  BadgeInfo,
  FileText,
  Lightbulb,
  MoreHorizontal,
} from "lucide-react";
import { TeachingTimelineItem } from "./teachingTypes";

interface TeachingTimelineProps {
  items: TeachingTimelineItem[];
  variant: "recording" | "raw_record" | "processing";
  highlightedItemIds?: string[];
}

const iconForKind = (kind: TeachingTimelineItem["kind"]) => {
  switch (kind) {
    case "note":
      return <Lightbulb size={14} className="text-amber-500" />;
    case "finding":
      return <Lightbulb size={14} className="text-emerald-500" />;
    case "artifact":
      return <FileText size={14} className="text-sky-500" />;
    case "system":
      return <BadgeInfo size={14} className="text-[color:var(--theme-accent)]" />;
    case "action":
    default:
      return <ArrowRight size={14} className="text-[color:var(--theme-accent)]" />;
  }
};

export function TeachingTimeline({
  items,
  variant,
  highlightedItemIds = [],
}: TeachingTimelineProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const highlightedIds = new Set(highlightedItemIds);
  const [followLatest, setFollowLatest] = useState(true);

  useEffect(() => {
    if (variant !== "processing") {
      setFollowLatest(true);
    }
  }, [variant]);

  useEffect(() => {
    if (variant !== "processing" || !followLatest) return;
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [items.length, followLatest, variant]);

  const handleScroll = () => {
    if (variant !== "processing") return;
    const element = scrollRef.current;
    if (!element) return;
    const nearBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    setFollowLatest(nearBottom);
  };

  const jumpToLatest = () => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    setFollowLatest(true);
  };

  if (!items.length) {
    return (
      <div className="rounded-[20px] border border-dashed border-[color:var(--border-soft)] bg-[linear-gradient(180deg,rgba(255,255,255,0.16)_0%,rgba(255,255,255,0.03)_100%)] px-4 py-6 text-sm text-[color:var(--text-secondary)]">
        {variant === "raw_record"
          ? "原始记录会在这里显示。"
          : variant === "processing"
            ? "AI 会在这里按时间顺序展示整理过程。"
            : "开始教学后，这里会按时间顺序展示操作和备注。"}
      </div>
    );
  }

  const timelineContent = (
    <div className="relative space-y-2.5">
      <div className="absolute left-4 top-1 h-full w-px bg-[linear-gradient(180deg,color-mix(in_srgb,var(--theme-accent)_45%,transparent)_0%,transparent_100%)]" />
      {items.map((item) => {
        const isNote = item.kind === "note";
        const isFinding = item.kind === "finding";
        const isArtifact = item.kind === "artifact";
        const isSystem = item.kind === "system";
        const isHighlighted = highlightedIds.has(item.id);
        return (
          <div
            key={item.id}
            className={`relative ml-1 rounded-[18px] border px-3.5 py-3 ${
              isHighlighted
                ? "border-[color:var(--field-border-strong)] bg-[var(--field-focus-ring)] shadow-[0_0_0_1px_var(--field-border-strong)]"
                : isNote
                ? "border-amber-200/70 bg-amber-50/70 dark:border-amber-800/40 dark:bg-amber-500/8"
                : isFinding
                  ? "border-emerald-200/80 bg-emerald-50/80 dark:border-emerald-800/40 dark:bg-emerald-500/10"
                : isArtifact
                  ? "border-sky-200/70 bg-sky-50/70 dark:border-sky-800/40 dark:bg-sky-500/8"
                  : isSystem
                    ? "border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/80"
                    : "border-[color:var(--border-soft)] bg-[linear-gradient(180deg,rgba(255,255,255,0.78)_0%,rgba(255,255,255,0.56)_100%)] dark:bg-[linear-gradient(180deg,rgba(23,25,27,0.92)_0%,rgba(23,25,27,0.72)_100%)]"
            }`}
          >
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[12px] border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90">
                {iconForKind(item.kind)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-[13px] font-semibold text-[color:var(--text-primary)]">
                    {item.title}
                  </div>
                  {item.badge ? (
                    <span className="rounded-full border border-[color:var(--border-soft)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--text-tertiary)]">
                      {item.badge}
                    </span>
                  ) : null}
                  <span className="text-[10px] text-[color:var(--text-tertiary)]">
                    {new Date(item.timestamp).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
                <div className="mt-1 text-[12px] leading-5 text-[color:var(--text-secondary)]">
                  {item.description}
                </div>
                {isHighlighted ? (
                  <div className="mt-2 text-[11px] font-semibold text-[color:var(--theme-accent)]">
                    当前卡片对应的原始记录
                  </div>
                ) : null}
                {item.detail ? (
                  <div className="mt-2 rounded-[12px] border border-[color:var(--border-soft)] bg-black/[0.03] px-2.5 py-2 text-[11px] text-[color:var(--text-secondary)] dark:bg-white/[0.03]">
                    {item.detail}
                  </div>
                ) : null}
                {item.artifactPath ? (
                  <div className="mt-2 rounded-[12px] border border-[color:var(--border-soft)] bg-black/[0.03] px-2.5 py-2 text-[11px] text-[color:var(--text-secondary)] dark:bg-white/[0.03]">
                    <div className="font-semibold text-[color:var(--text-primary)]">
                      页面变化证据
                    </div>
                    <div className="mt-0.5">
                      这一步已经保留了详细页面变化记录，AI 需要时可以继续读取，不会直接把长内容挤进当前视图。
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
      <div className="ml-1 flex items-center gap-2 px-3 text-[11px] text-[color:var(--text-tertiary)]">
        <MoreHorizontal size={14} />
        {variant === "raw_record"
          ? "当前为原始记录只读视图。"
          : variant === "processing"
            ? "AI 会按时间顺序追加可理解的处理日志，不显示模型内部思维文本。"
            : "用户备注和操作痕迹会按时间顺序混排。"}
      </div>
    </div>
  );

  if (variant !== "processing") {
    return timelineContent;
  }

  return (
    <div className="relative">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="max-h-[340px] overflow-y-auto pr-1"
      >
        {timelineContent}
      </div>
      {!followLatest && items.length > 2 ? (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-3 right-3 rounded-full border border-[color:var(--field-border-strong)] bg-[var(--theme-accent)] px-3 py-1.5 text-[11px] font-semibold text-white shadow-[0_10px_20px_rgba(15,118,110,0.18)] transition-colors hover:brightness-95"
        >
          回到最新
        </button>
      ) : null}
    </div>
  );
}
