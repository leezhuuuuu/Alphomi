import React from "react";
import { TeachingReviewCard, TeachingReviewScope, TeachingTimelineItem } from "./teachingTypes";
import { TeachingTimeline } from "./TeachingTimeline";

interface TeachingReviewProps {
  cards: TeachingReviewCard[];
  scope: TeachingReviewScope;
  draftTitle: string;
  draftSummary: string;
  canEditTitle: boolean;
  rawItems: TeachingTimelineItem[];
  highlightedItemIds: string[];
  onDraftTitleChange: (value: string) => void;
  onToggleScope: () => void;
  onLocateCard: (cardId: string) => void;
}

export function TeachingReview({
  cards,
  scope,
  draftTitle,
  draftSummary,
  canEditTitle,
  rawItems,
  highlightedItemIds,
  onDraftTitleChange,
  onToggleScope,
  onLocateCard,
}: TeachingReviewProps) {
  if (scope === "raw_record") {
    return (
      <div className="rounded-[20px] border border-[color:var(--border-soft)] bg-[linear-gradient(180deg,rgba(255,255,255,0.14)_0%,rgba(255,255,255,0.05)_100%)] p-3">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">
              原始教学记录
            </div>
            <div className="mt-1 text-[15px] font-semibold text-[color:var(--text-primary)]">
              {draftTitle}
            </div>
            <div className="mt-1 text-[12px] text-[color:var(--text-secondary)]">
              {draftSummary}
            </div>
          </div>
          <button
            type="button"
            onClick={onToggleScope}
            className="rounded-full border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 px-3 py-1.5 text-[11px] font-semibold text-[color:var(--text-primary)] transition-colors hover:border-[color:var(--border-strong)]"
          >
            返回流程草稿
          </button>
        </div>
        <TeachingTimeline
          items={rawItems}
          variant="raw_record"
          highlightedItemIds={highlightedItemIds}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-[20px] border border-[color:var(--border-soft)] bg-[linear-gradient(180deg,rgba(255,255,255,0.14)_0%,rgba(255,255,255,0.05)_100%)] p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">
              流程草稿
            </div>
            {canEditTitle ? (
              <div className="mt-2">
                <label className="mb-1 block text-[11px] font-medium text-[color:var(--text-secondary)]">
                  流程名称
                </label>
                <input
                  type="text"
                  value={draftTitle}
                  onChange={(event) => onDraftTitleChange(event.target.value)}
                  placeholder="请输入流程名称"
                  className="w-full rounded-[14px] border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 px-3 py-2 text-[13px] font-semibold text-[color:var(--text-primary)] outline-none transition-colors focus:border-[color:var(--field-border-strong)]"
                />
              </div>
            ) : (
              <div className="mt-1 text-[15px] font-semibold text-[color:var(--text-primary)]">
                {draftTitle}
              </div>
            )}
            <div className="mt-1 text-[12px] text-[color:var(--text-secondary)]">
              {draftSummary}
            </div>
            {canEditTitle ? (
              <div className="mt-1 text-[11px] text-[color:var(--text-tertiary)]">
                保存前可以直接修改这个名称。
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onToggleScope}
            className="rounded-full border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 px-3 py-1.5 text-[11px] font-semibold text-[color:var(--text-primary)] transition-colors hover:border-[color:var(--border-strong)]"
          >
            查看原始记录
          </button>
        </div>
      </div>

      <div className="space-y-3">
        {!cards.length ? (
          <div className="rounded-[20px] border border-dashed border-[color:var(--border-soft)] bg-[linear-gradient(180deg,rgba(255,255,255,0.16)_0%,rgba(255,255,255,0.05)_100%)] p-4 text-[12px] leading-6 text-[color:var(--text-secondary)]">
            当前还没有可审阅的阶段卡片。你可以先查看原始记录，或继续用自然语言补充修订要求。
          </div>
        ) : null}
        {cards.map((card, index) => (
          <div
            key={card.id}
            className="rounded-[20px] border border-[color:var(--border-soft)] bg-[linear-gradient(180deg,rgba(255,255,255,0.95)_0%,rgba(255,255,255,0.76)_100%)] p-3.5 shadow-[0_12px_28px_rgba(26,30,36,0.07)] dark:bg-[linear-gradient(180deg,rgba(24,27,30,0.96)_0%,rgba(24,27,30,0.84)_100%)]"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">
                  阶段 {index + 1}
                </div>
                <div className="mt-1 text-[14px] font-semibold text-[color:var(--text-primary)]">
                  {card.title}
                </div>
                <div className="mt-1 text-[12px] leading-5 text-[color:var(--text-secondary)]">
                  {card.goal}
                </div>
              </div>
            </div>

            <div className="mt-3 rounded-[16px] border border-[color:var(--border-soft)] bg-black/[0.025] p-3 dark:bg-white/[0.025]">
              <div className="text-[10px] uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">
                关键操作
              </div>
              <div className="mt-2 space-y-1.5">
                {card.keyActions.map((action, actionIdx) => (
                  <div
                    key={`${card.id}-action-${actionIdx}`}
                    className="flex items-start gap-2 text-[12px] text-[color:var(--text-primary)]"
                  >
                    <span className="mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--theme-accent)]" />
                    <span className="leading-5">{action}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-3 text-[11px] text-[color:var(--text-tertiary)]">
              证据锚点: {card.evidence}
            </div>

            <div className="mt-3">
              <button
                type="button"
                onClick={() => onLocateCard(card.id)}
                className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 px-3 py-1.5 text-[11px] font-semibold text-[color:var(--text-primary)] transition-colors hover:border-[color:var(--border-strong)]"
              >
                查看对应原始记录
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
