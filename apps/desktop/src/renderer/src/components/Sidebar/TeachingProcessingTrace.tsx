import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  BadgeInfo,
  ChevronDown,
  ChevronRight,
  FileText,
  Lightbulb,
} from "lucide-react";
import { TeachingProcessingStep, TeachingTimelineItem } from "./teachingTypes";

interface TeachingProcessingTraceProps {
  steps: TeachingProcessingStep[];
  items: TeachingTimelineItem[];
}

const statusLabel: Record<TeachingProcessingStep["state"], string> = {
  pending: "等待中",
  active: "进行中",
  done: "已完成",
};

const iconForKind = (kind: TeachingTimelineItem["kind"]) => {
  switch (kind) {
    case "finding":
      return <Lightbulb size={14} className="text-emerald-500" />;
    case "artifact":
      return <FileText size={14} className="text-sky-500" />;
    case "note":
      return <Lightbulb size={14} className="text-amber-500" />;
    case "system":
      return <BadgeInfo size={14} className="text-[color:var(--theme-accent)]" />;
    case "action":
    default:
      return <ArrowRight size={14} className="text-[color:var(--theme-accent)]" />;
  }
};

const statusTone = (state: TeachingProcessingStep["state"]) => {
  if (state === "active") {
    return "border-[color:var(--field-border-strong)] bg-[var(--field-focus-ring)]";
  }
  if (state === "done") {
    return "border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/86";
  }
  return "border-[color:var(--border-soft)] bg-[linear-gradient(180deg,rgba(255,255,255,0.16)_0%,rgba(255,255,255,0.05)_100%)]";
};

const buildPhaseSummary = (
  step: TeachingProcessingStep,
  items: TeachingTimelineItem[],
) => {
  if (!items.length) return step.description;
  const highlighted =
    [...items].reverse().find((item) => item.kind === "finding") ||
    items[items.length - 1];
  return highlighted.description || highlighted.title || step.description;
};

export function TeachingProcessingTrace({
  steps,
  items,
}: TeachingProcessingTraceProps) {
  const groupedItems = useMemo(() => {
    const map = new Map<string, TeachingTimelineItem[]>();
    for (const step of steps) {
      map.set(step.id, []);
    }
    for (const item of items) {
      const key = item.phaseId && map.has(item.phaseId) ? item.phaseId : steps[0]?.id;
      if (!key) continue;
      map.get(key)?.push(item);
    }
    return map;
  }, [items, steps]);

  const [expandedPhases, setExpandedPhases] = useState<Record<string, boolean>>({});
  const [expandedEntries, setExpandedEntries] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setExpandedPhases((previous) => {
      const next = { ...previous };
      let changed = false;
      for (const step of steps) {
        if (next[step.id] === undefined) {
          next[step.id] = step.state === "active";
          changed = true;
        } else if (step.state === "active" && next[step.id] === false) {
          next[step.id] = true;
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [steps]);

  const expandAll = () => {
    setExpandedPhases(
      Object.fromEntries(steps.map((step) => [step.id, true])),
    );
  };

  const collapseAll = () => {
    setExpandedPhases(
      Object.fromEntries(steps.map((step) => [step.id, false])),
    );
  };

  const togglePhase = (phaseId: string) => {
    setExpandedPhases((previous) => ({
      ...previous,
      [phaseId]: !previous[phaseId],
    }));
  };

  const toggleEntry = (entryId: string) => {
    setExpandedEntries((previous) => ({
      ...previous,
      [entryId]: !previous[entryId],
    }));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12px] leading-5 text-[color:var(--text-secondary)]">
          当前运行中的阶段会默认展开。你也可以随时展开历史阶段，回看 agent 在每一步里读取了什么、确认了什么。
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={expandAll}
            className="rounded-full border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 px-3 py-1.5 text-[11px] font-semibold text-[color:var(--text-primary)] transition-colors hover:border-[color:var(--border-strong)]"
          >
            全部展开
          </button>
          <button
            type="button"
            onClick={collapseAll}
            className="rounded-full border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 px-3 py-1.5 text-[11px] font-semibold text-[color:var(--text-secondary)] transition-colors hover:text-[color:var(--text-primary)]"
          >
            全部折叠
          </button>
        </div>
      </div>

      <div className="space-y-3">
        {steps.map((step) => {
          const phaseItems = groupedItems.get(step.id) || [];
          const isExpanded = expandedPhases[step.id] ?? step.state === "active";
          return (
            <div
              key={step.id}
              className={`rounded-[20px] border px-3.5 py-3 ${statusTone(step.state)}`}
            >
              <button
                type="button"
                onClick={() => togglePhase(step.id)}
                className="flex w-full items-start justify-between gap-3 text-left"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold text-[color:var(--text-primary)]">
                      {step.label}
                    </span>
                    <span className="rounded-full border border-[color:var(--border-soft)] px-2 py-0.5 text-[10px] font-semibold text-[color:var(--text-tertiary)]">
                      {statusLabel[step.state]}
                    </span>
                    <span className="text-[10px] text-[color:var(--text-tertiary)]">
                      {phaseItems.length} 条工作记录
                    </span>
                  </div>
                  <div className="mt-1 text-[12px] leading-5 text-[color:var(--text-secondary)]">
                    {buildPhaseSummary(step, phaseItems)}
                  </div>
                </div>
                <span className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-full border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 text-[color:var(--text-secondary)]">
                  {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </span>
              </button>

              {isExpanded ? (
                <div className="mt-3 space-y-2.5 border-t border-[color:var(--border-soft)] pt-3">
                  {phaseItems.length === 0 ? (
                    <div className="rounded-[16px] border border-dashed border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/72 px-3 py-3 text-[12px] text-[color:var(--text-secondary)]">
                      这个阶段还没有更细的工作记录。
                    </div>
                  ) : null}

                  {phaseItems.map((item) => {
                    const canExpand = Boolean(item.detail);
                    const expanded = expandedEntries[item.id] ?? false;
                    return (
                      <div
                        key={item.id}
                        className={`rounded-[16px] border px-3 py-3 ${
                          item.kind === "finding"
                            ? "border-emerald-200/80 bg-emerald-50/80 dark:border-emerald-800/40 dark:bg-emerald-500/10"
                            : item.kind === "artifact"
                              ? "border-sky-200/80 bg-sky-50/80 dark:border-sky-800/40 dark:bg-sky-500/10"
                              : "border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/86"
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[12px] border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90">
                            {iconForKind(item.kind)}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="text-[12px] font-semibold text-[color:var(--text-primary)]">
                                {item.title}
                              </div>
                              <span className="text-[10px] text-[color:var(--text-tertiary)]">
                                {new Date(item.timestamp).toLocaleTimeString([], {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                              </span>
                              {item.badge ? (
                                <span className="rounded-full border border-[color:var(--border-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--text-tertiary)]">
                                  {item.badge}
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-1 text-[12px] leading-5 text-[color:var(--text-secondary)]">
                              {item.description}
                            </div>
                            {canExpand ? (
                              <button
                                type="button"
                                onClick={() => toggleEntry(item.id)}
                                className="mt-2 text-[11px] font-semibold text-[color:var(--theme-accent)] transition-colors hover:brightness-95"
                              >
                                {expanded ? "收起详情" : "展开详情"}
                              </button>
                            ) : null}
                            {expanded && item.detail ? (
                              <div className="mt-2 rounded-[12px] border border-[color:var(--border-soft)] bg-black/[0.03] px-2.5 py-2 text-[11px] leading-5 text-[color:var(--text-secondary)] dark:bg-white/[0.03]">
                                {item.detail}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
