import React from "react";
import {
  BookOpen,
  ChevronLeft,
  Clock3,
  Layers3,
  LibraryBig,
} from "lucide-react";
import {
  TeachingSavedAssetDetail,
  TeachingSavedAssetSummary,
} from "./teachingTypes";

interface TeachingSavedAssetsProps {
  assets: TeachingSavedAssetSummary[];
  selectedAsset: TeachingSavedAssetDetail | null;
  isLoading: boolean;
  isDetailLoading: boolean;
  onOpenAsset: (assetId: string) => void;
  onBackToList: () => void;
}

const formatSavedTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

export function TeachingSavedAssets({
  assets,
  selectedAsset,
  isLoading,
  isDetailLoading,
  onOpenAsset,
  onBackToList,
}: TeachingSavedAssetsProps) {
  if (selectedAsset) {
    return (
      <div className="space-y-3">
        <div className="rounded-[20px] border border-[color:var(--border-soft)] bg-[linear-gradient(180deg,rgba(255,255,255,0.14)_0%,rgba(255,255,255,0.05)_100%)] p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[10px] uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">
                已保存教学
              </div>
              <div className="mt-1 text-[15px] font-semibold text-[color:var(--text-primary)]">
                {selectedAsset.title}
              </div>
              <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-[color:var(--text-secondary)]">
                <span className="inline-flex items-center gap-1 rounded-full border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 px-2.5 py-1">
                  <Clock3 size={12} />
                  {formatSavedTime(selectedAsset.createdAt)}
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 px-2.5 py-1">
                  <Layers3 size={12} />
                  {selectedAsset.cardCount} 个阶段
                </span>
                {selectedAsset.sourceDomain ? (
                  <span className="rounded-full border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 px-2.5 py-1">
                    {selectedAsset.sourceDomain}
                  </span>
                ) : null}
              </div>
            </div>
            <button
              type="button"
              onClick={onBackToList}
              className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 px-3 py-1.5 text-[11px] font-semibold text-[color:var(--text-primary)] transition-colors hover:border-[color:var(--border-strong)]"
            >
              <ChevronLeft size={12} />
              返回列表
            </button>
          </div>
          {selectedAsset.sourceTitle ? (
            <div className="mt-2 text-[12px] leading-5 text-[color:var(--text-secondary)]">
              来源页面：{selectedAsset.sourceTitle}
            </div>
          ) : null}
        </div>

        <div className="space-y-3">
          {selectedAsset.cards.map((card, index) => (
            <div
              key={card.id}
              className="rounded-[20px] border border-[color:var(--border-soft)] bg-[linear-gradient(180deg,rgba(255,255,255,0.95)_0%,rgba(255,255,255,0.76)_100%)] p-3.5 shadow-[0_12px_28px_rgba(26,30,36,0.07)] dark:bg-[linear-gradient(180deg,rgba(24,27,30,0.96)_0%,rgba(24,27,30,0.84)_100%)]"
            >
              <div className="text-[10px] uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">
                阶段 {index + 1}
              </div>
              <div className="mt-1 text-[14px] font-semibold text-[color:var(--text-primary)]">
                {card.title}
              </div>
              <div className="mt-1 text-[12px] leading-5 text-[color:var(--text-secondary)]">
                {card.goal}
              </div>
              <div className="mt-3 rounded-[16px] border border-[color:var(--border-soft)] bg-black/[0.025] p-3 dark:bg-white/[0.025]">
                <div className="text-[10px] uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">
                  关键操作
                </div>
                <div className="mt-2 space-y-1.5">
                  {card.keyActions.map((action, actionIdx) => (
                    <div
                      key={`${card.id}-saved-action-${actionIdx}`}
                      className="flex items-start gap-2 text-[12px] text-[color:var(--text-primary)]"
                    >
                      <span className="mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--theme-accent)]" />
                      <span className="leading-5">{action}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-[20px] border border-[color:var(--border-soft)] bg-[linear-gradient(180deg,rgba(255,255,255,0.14)_0%,rgba(255,255,255,0.05)_100%)] p-3">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-[16px] border border-[color:var(--border-soft)] bg-[var(--field-focus-ring)] text-[color:var(--theme-accent)]">
            <LibraryBig size={18} />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">
              Saved teachings
            </div>
            <div className="mt-1 text-[15px] font-semibold text-[color:var(--text-primary)]">
              手动查看曾经保存过的教学
            </div>
            <div className="mt-1 text-[12px] leading-5 text-[color:var(--text-secondary)]">
              这里展示已经保存下来的教学流程。你可以先浏览列表，再点开查看阶段卡片详情。
            </div>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="rounded-[20px] border border-dashed border-[color:var(--border-soft)] bg-[linear-gradient(180deg,rgba(255,255,255,0.16)_0%,rgba(255,255,255,0.05)_100%)] p-4 text-[12px] leading-6 text-[color:var(--text-secondary)]">
          正在加载已保存教学列表...
        </div>
      ) : null}

      {!isLoading && assets.length === 0 ? (
        <div className="rounded-[20px] border border-dashed border-[color:var(--border-soft)] bg-[linear-gradient(180deg,rgba(255,255,255,0.16)_0%,rgba(255,255,255,0.05)_100%)] p-4 text-[12px] leading-6 text-[color:var(--text-secondary)]">
          当前还没有已保存教学。你可以先完成一次教学并点击保存流程。
        </div>
      ) : null}

      {!isLoading && assets.length > 0 ? (
        <div className="space-y-3">
          {assets.map((asset) => (
            <button
              key={asset.id}
              type="button"
              onClick={() => onOpenAsset(asset.id)}
              className="w-full rounded-[20px] border border-[color:var(--border-soft)] bg-[linear-gradient(180deg,rgba(255,255,255,0.95)_0%,rgba(255,255,255,0.76)_100%)] p-3.5 text-left shadow-[0_12px_28px_rgba(26,30,36,0.07)] transition-colors hover:border-[color:var(--border-strong)] dark:bg-[linear-gradient(180deg,rgba(24,27,30,0.96)_0%,rgba(24,27,30,0.84)_100%)]"
            >
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[12px] border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90">
                  <BookOpen size={15} className="text-[color:var(--theme-accent)]" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-semibold text-[color:var(--text-primary)]">
                    {asset.title}
                  </div>
                  <div className="mt-1 text-[12px] text-[color:var(--text-secondary)]">
                    {asset.sourceTitle || asset.sourceDomain || "未记录来源页面"}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-[color:var(--text-secondary)]">
                    <span className="inline-flex items-center gap-1 rounded-full border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 px-2.5 py-1">
                      <Clock3 size={12} />
                      {formatSavedTime(asset.createdAt)}
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-full border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 px-2.5 py-1">
                      <Layers3 size={12} />
                      {asset.cardCount} 个阶段
                    </span>
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      ) : null}

      {isDetailLoading ? (
        <div className="rounded-[20px] border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 p-4 text-[12px] text-[color:var(--text-secondary)]">
          正在加载教学详情...
        </div>
      ) : null}
    </div>
  );
}
