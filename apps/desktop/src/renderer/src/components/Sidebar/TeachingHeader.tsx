import React from "react";
import {
  Circle,
  ChevronLeft,
  BookOpen,
  PlayCircle,
  Save,
  Square,
} from "lucide-react";
import { TeachingContextSnapshot, TeachingProcessingStep, TeachingReviewScope, TeachingViewMode } from "./teachingTypes";

const formatContextMeta = (context: TeachingContextSnapshot) => {
  const title = context.title?.trim() || "当前标签页";
  const url = context.url?.trim();
  if (!url) return `${title} · 仅记录当前标签页`;

  try {
    const parsed = new URL(url);
    return `${title} · ${parsed.hostname} · 仅记录当前标签页`;
  } catch {
    return `${title} · 仅记录当前标签页`;
  }
};

interface TeachingHeaderProps {
  mode: TeachingViewMode;
  context: TeachingContextSnapshot;
  reviewScope: TeachingReviewScope;
  processingSteps: TeachingProcessingStep[];
  elapsedLabel: string;
  draftTitle: string;
  draftSummary: string;
  savedAt?: string | null;
  canSaveDraft: boolean;
  isSavingDraft: boolean;
  hasSavedAssetSelection: boolean;
  onStart: () => void;
  onStop: () => void;
  onCancel: () => void;
  onExit: () => void;
  onToggleReviewScope: () => void;
  onSave: () => void;
  onOpenSavedAssets: () => void;
  onCloseSavedAssets: () => void;
  onBackToSavedAssetsList: () => void;
}

const describeMode = (mode: TeachingViewMode) => {
  switch (mode) {
    case "setup":
      return "开始教学";
    case "recording":
      return "教学中";
    case "processing":
      return "正在整理流程";
    case "review":
      return "流程草稿";
    case "library":
      return "已保存教学";
    default:
      return "教学模式";
  }
};

export function TeachingHeader({
  mode,
  context,
  reviewScope,
  processingSteps,
  elapsedLabel,
  draftTitle,
  draftSummary,
  savedAt,
  canSaveDraft,
  isSavingDraft,
  hasSavedAssetSelection,
  onStart,
  onStop,
  onCancel,
  onExit,
  onToggleReviewScope,
  onSave,
  onOpenSavedAssets,
  onCloseSavedAssets,
  onBackToSavedAssetsList,
}: TeachingHeaderProps) {
  const isSetup = mode === "setup";
  const isRecording = mode === "recording";
  const isProcessing = mode === "processing";
  const isReview = mode === "review";
  const isLibrary = mode === "library";
  const activeCount = processingSteps.filter((step) => step.state !== "pending").length;
  const totalCount = processingSteps.length;
  const activeStep = processingSteps.find((step) => step.state === "active");
  const contextLine = isLibrary
    ? "浏览并手动查看已保存的教学流程"
    : formatContextMeta(context);
  const summaryLine = [draftTitle?.trim(), draftSummary?.trim()]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="border-b border-[color:var(--border-soft)] bg-[linear-gradient(180deg,rgba(255,255,255,0.12)_0%,transparent_100%)] px-3.5 py-3">
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-[18px] border border-[color:var(--border-soft)] bg-[var(--field-focus-ring)] text-[color:var(--theme-accent)] shadow-[var(--shadow-soft)]">
          <BookOpen size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-[0.18em] text-[color:var(--text-tertiary)]">
            教学工作台
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            <h2 className="truncate text-[16px] font-semibold text-[color:var(--text-primary)]">
              {describeMode(mode)}
            </h2>
            {savedAt && !isLibrary ? (
              <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:border-emerald-700/50 dark:bg-emerald-500/10 dark:text-emerald-300">
                已保存
              </span>
            ) : null}
          </div>
          <div className="mt-1 text-[12px] leading-5 text-[color:var(--text-secondary)]">
            {contextLine}
          </div>
          {summaryLine ? (
            <div className="mt-1 line-clamp-2 text-[11px] leading-5 text-[color:var(--text-tertiary)]">
              {summaryLine}
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {isSetup ? (
          <>
            <button
              type="button"
              onClick={onStart}
              className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--field-border-strong)] bg-[var(--theme-accent)] px-3 py-1.5 text-[11px] font-semibold text-white shadow-[0_10px_20px_rgba(15,118,110,0.22)] transition-colors hover:brightness-95"
            >
              <PlayCircle size={14} />
              开始学习
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 px-3 py-1.5 text-[11px] font-semibold text-[color:var(--text-secondary)] transition-colors hover:text-[color:var(--text-primary)]"
            >
              返回对话
            </button>
            <button
              type="button"
              onClick={onOpenSavedAssets}
              className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 px-3 py-1.5 text-[11px] font-semibold text-[color:var(--text-primary)] transition-colors hover:border-[color:var(--border-strong)]"
            >
              已保存教学
            </button>
          </>
        ) : null}

        {isRecording ? (
          <>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 px-3 py-1.5 text-[11px] font-semibold text-[color:var(--text-primary)]">
              <Circle size={10} className="fill-emerald-500 text-emerald-500" />
              记录中 {elapsedLabel}
            </span>
            <button
              type="button"
              onClick={onStop}
              className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--border-soft)] bg-[color:var(--shell-surface-muted)] px-3 py-1.5 text-[11px] font-semibold text-[color:var(--text-primary)] transition-colors hover:border-[color:var(--border-strong)]"
            >
              <Square size={12} />
              停止学习
            </button>
            <button
              type="button"
              onClick={onExit}
              className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 px-3 py-1.5 text-[11px] font-semibold text-[color:var(--text-secondary)] transition-colors hover:text-[color:var(--text-primary)]"
            >
              <ChevronLeft size={12} />
              放弃本次教学
            </button>
          </>
        ) : null}

        {isProcessing ? (
          <>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 px-3 py-1.5 text-[11px] font-semibold text-[color:var(--text-primary)]">
              {activeStep ? activeStep.label : "正在整理流程"}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--border-soft)] bg-[var(--field-focus-ring)] px-3 py-1.5 text-[11px] font-semibold text-[color:var(--theme-accent)]">
              {activeCount}/{totalCount || 4}
            </span>
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 px-3 py-1.5 text-[11px] font-semibold text-[color:var(--text-secondary)] transition-colors hover:text-[color:var(--text-primary)]"
            >
              放弃本次教学
            </button>
          </>
        ) : null}

        {isReview ? (
          <>
            <button
              type="button"
              onClick={onToggleReviewScope}
              className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 px-3 py-1.5 text-[11px] font-semibold text-[color:var(--text-primary)] transition-colors hover:border-[color:var(--border-strong)]"
            >
              {reviewScope === "draft" ? "查看原始记录" : "返回流程草稿"}
            </button>
            {savedAt ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-[11px] font-semibold text-emerald-700 dark:border-emerald-700/50 dark:bg-emerald-500/10 dark:text-emerald-300">
                <Save size={12} />
                已保存
              </span>
            ) : (
              <button
                type="button"
                onClick={onSave}
                disabled={!canSaveDraft || isSavingDraft}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-semibold transition-colors ${
                  !canSaveDraft || isSavingDraft
                    ? "cursor-not-allowed border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 text-[color:var(--text-tertiary)] shadow-none"
                    : "border-[color:var(--field-border-strong)] bg-[var(--theme-accent)] text-white shadow-[0_10px_20px_rgba(15,118,110,0.22)] hover:brightness-95"
                }`}
              >
                <Save size={12} />
                {!canSaveDraft ? "等待草稿" : isSavingDraft ? "保存中..." : "保存流程"}
              </button>
            )}
            <button
              type="button"
              onClick={onExit}
              className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 px-3 py-1.5 text-[11px] font-semibold text-[color:var(--text-secondary)] transition-colors hover:text-[color:var(--text-primary)]"
            >
              {savedAt ? "完成" : "退出教学"}
            </button>
            <button
              type="button"
              onClick={onOpenSavedAssets}
              className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 px-3 py-1.5 text-[11px] font-semibold text-[color:var(--text-primary)] transition-colors hover:border-[color:var(--border-strong)]"
            >
              已保存教学
            </button>
          </>
        ) : null}

        {isLibrary ? (
          <>
            {hasSavedAssetSelection ? (
              <button
                type="button"
                onClick={onBackToSavedAssetsList}
                className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 px-3 py-1.5 text-[11px] font-semibold text-[color:var(--text-primary)] transition-colors hover:border-[color:var(--border-strong)]"
              >
                返回列表
              </button>
            ) : null}
            <button
              type="button"
              onClick={onCloseSavedAssets}
              className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 px-3 py-1.5 text-[11px] font-semibold text-[color:var(--text-secondary)] transition-colors hover:text-[color:var(--text-primary)]"
            >
              <ChevronLeft size={12} />
              返回教学
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
