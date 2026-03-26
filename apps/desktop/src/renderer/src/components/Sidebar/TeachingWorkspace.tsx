import React from "react";
import { TeachingComposer } from "./TeachingComposer";
import { TeachingHeader } from "./TeachingHeader";
import { TeachingProcessingTrace } from "./TeachingProcessingTrace";
import { TeachingReview } from "./TeachingReview";
import { TeachingSavedAssets } from "./TeachingSavedAssets";
import { TeachingTimeline } from "./TeachingTimeline";
import { TeachingModeState } from "./useTeachingModeState";

interface TeachingWorkspaceProps {
  teaching: TeachingModeState;
}

const ERROR_HINTS = ["失败", "无法", "失效", "未找到", "未连接", "请稍后重试"];

const resolveStatusNotice = (teaching: TeachingModeState) => {
  const summary = teaching.draft.summary?.trim();
  if (!summary || teaching.mode === "processing" || teaching.mode === "setup") {
    return null;
  }

  if (teaching.savedAt && teaching.mode === "review") {
    return {
      tone: "success" as const,
      title: "流程已保存",
      message: summary,
    };
  }

  if (ERROR_HINTS.some((hint) => summary.includes(hint))) {
    return {
      tone: "error" as const,
      title: teaching.mode === "library" ? "读取失败" : "当前操作未完成",
      message: summary,
    };
  }

  if (teaching.mode === "review" && !teaching.reviewCards.length) {
    return {
      tone: "warning" as const,
      title: "还没有可审阅的流程卡片",
      message: summary,
    };
  }

  return null;
};

export function TeachingWorkspace({ teaching }: TeachingWorkspaceProps) {
  const isSetup = teaching.mode === "setup";
  const isRecording = teaching.mode === "recording";
  const isProcessing = teaching.mode === "processing";
  const isReview = teaching.mode === "review";
  const isLibrary = teaching.mode === "library";
  const statusNotice = resolveStatusNotice(teaching);
  const headerDraftTitle = isLibrary
    ? teaching.selectedSavedAsset?.title || "已保存教学"
    : teaching.draft.title;
  const headerDraftSummary = isLibrary
    ? teaching.selectedSavedAsset
      ? `保存于 ${new Date(teaching.selectedSavedAsset.createdAt).toLocaleString()}`
      : teaching.savedAssetsLoading
        ? "正在加载已保存教学列表。"
        : `当前共 ${teaching.savedAssets.length} 条已保存教学。`
    : teaching.draft.summary;

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[var(--assistant-surface)]">
      <TeachingHeader
        mode={teaching.mode}
        context={teaching.context}
        reviewScope={teaching.reviewScope}
        processingSteps={teaching.processingSteps}
        elapsedLabel={teaching.elapsedLabel}
        draftTitle={headerDraftTitle}
        draftSummary={headerDraftSummary}
        savedAt={teaching.savedAt}
        canSaveDraft={teaching.canSaveDraft}
        isSavingDraft={teaching.isSavingDraft}
        hasSavedAssetSelection={Boolean(teaching.selectedSavedAsset)}
        onStart={teaching.beginTeaching}
        onStop={teaching.stopTeaching}
        onCancel={teaching.cancelTeaching}
        onExit={teaching.exitTeaching}
        onToggleReviewScope={teaching.toggleReviewScope}
        onSave={teaching.saveDraft}
        onOpenSavedAssets={teaching.openSavedAssets}
        onCloseSavedAssets={teaching.closeSavedAssets}
        onBackToSavedAssetsList={teaching.closeSavedAssetDetail}
      />

      <div className="flex-1 overflow-y-auto px-3.5 py-3 pb-32">
        {statusNotice ? (
          <div
            className={`mb-3 rounded-[18px] border px-3.5 py-3 ${
              statusNotice.tone === "success"
                ? "border-emerald-200/80 bg-emerald-50/90 dark:border-emerald-800/40 dark:bg-emerald-500/10"
                : statusNotice.tone === "error"
                  ? "border-rose-200/80 bg-rose-50/90 dark:border-rose-800/40 dark:bg-rose-500/10"
                  : "border-amber-200/80 bg-amber-50/90 dark:border-amber-800/40 dark:bg-amber-500/10"
            }`}
          >
            <div className="text-[12px] font-semibold text-[color:var(--text-primary)]">
              {statusNotice.title}
            </div>
            <div className="mt-1 text-[12px] leading-5 text-[color:var(--text-secondary)]">
              {statusNotice.message}
            </div>
          </div>
        ) : null}

        {isSetup ? (
          <div className="rounded-[24px] border border-[color:var(--border-soft)] bg-[linear-gradient(180deg,rgba(255,255,255,0.18)_0%,rgba(255,255,255,0.06)_100%)] p-4 shadow-[var(--shadow-soft)]">
            <div className="mt-2 text-[15px] font-semibold text-[color:var(--text-primary)]">
              准备开始教学
            </div>
            <div className="mt-2 text-[12px] leading-5 text-[color:var(--text-secondary)]">
              左侧继续正常操作，开始学习后右侧会切成教学流水线，只记录当前标签页中的操作和备注，AI 会在停止学习后再统一整理。
            </div>
            <div className="mt-4 rounded-[18px] border border-dashed border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/72 px-3 py-3 text-[12px] text-[color:var(--text-secondary)]">
              {teaching.context.title || "当前标签页"} · {teaching.context.url || "等待浏览器上下文"}
            </div>
          </div>
        ) : null}

        {isRecording ? (
          <TeachingTimeline items={teaching.timeline} variant="recording" />
        ) : null}

        {isProcessing ? (
          <div className="space-y-3">
            <div className="rounded-[22px] border border-[color:var(--border-soft)] bg-[linear-gradient(180deg,rgba(255,255,255,0.18)_0%,rgba(255,255,255,0.06)_100%)] p-3 shadow-[var(--shadow-soft)]">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">
                    整理进度
                  </div>
                  <div className="mt-1 text-[14px] font-semibold text-[color:var(--text-primary)]">
                    AI 正在分阶段整理这次教学数据
                  </div>
                </div>
                {teaching.processingOverview ? (
                  <div className="flex flex-wrap gap-2">
                    <span className="rounded-full border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 px-3 py-1 text-[11px] font-semibold text-[color:var(--text-primary)]">
                      {teaching.processingOverview.actionItems} 条操作
                    </span>
                    <span className="rounded-full border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 px-3 py-1 text-[11px] font-semibold text-[color:var(--text-primary)]">
                      {teaching.processingOverview.noteItems} 条备注
                    </span>
                    <span className="rounded-full border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 px-3 py-1 text-[11px] font-semibold text-[color:var(--text-primary)]">
                      {teaching.processingOverview.artifactCount} 个变化文件
                    </span>
                  </div>
                ) : null}
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {teaching.processingSteps.map((step, index) => (
                  <div
                    key={step.id}
                    className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-semibold ${
                      step.state === "active"
                        ? "border-[color:var(--field-border-strong)] bg-[var(--field-focus-ring)] text-[color:var(--theme-accent)]"
                        : step.state === "done"
                          ? "border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/86 text-[color:var(--text-primary)]"
                          : "border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/70 text-[color:var(--text-tertiary)]"
                    }`}
                  >
                    <span className="flex h-5 w-5 items-center justify-center rounded-full border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 text-[10px]">
                      {step.state === "done" ? "✓" : step.state === "active" ? "…" : index + 1}
                    </span>
                    <span>{step.label}</span>
                  </div>
                ))}
              </div>

              <div className="mt-3 text-[12px] leading-5 text-[color:var(--text-secondary)]">
                原始教学记录已保留。下面的时间线只展示 AI 可解释的整理动作和中间发现，不展示模型内部思维文本。
              </div>
            </div>

            <div className="rounded-[22px] border border-[color:var(--border-soft)] bg-[linear-gradient(180deg,rgba(255,255,255,0.18)_0%,rgba(255,255,255,0.06)_100%)] p-3 shadow-[var(--shadow-soft)]">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">
                    Agent 工作记录
                  </div>
                  <div className="mt-1 text-[14px] font-semibold text-[color:var(--text-primary)]">
                    Agent 正在一步一步调查和整理这次教学数据
                  </div>
                  <div className="mt-1 text-[12px] leading-5 text-[color:var(--text-secondary)]">
                    每个阶段都可以展开或折叠。展开后可以看到它在该阶段里读取了什么、核对了什么，以及得出了哪些中间结论。
                  </div>
                </div>
              </div>

              <div className="mt-3">
                <TeachingProcessingTrace
                  steps={teaching.processingSteps}
                  items={teaching.processingFeed}
                />
              </div>
            </div>
          </div>
        ) : null}

        {isReview ? (
          <TeachingReview
            cards={teaching.reviewCards}
            scope={teaching.reviewScope}
            draftTitle={teaching.draft.title}
            draftSummary={teaching.draft.summary}
            canEditTitle={!teaching.savedAt}
            rawItems={teaching.timeline}
            highlightedItemIds={teaching.highlightedItemIds}
            onDraftTitleChange={teaching.setDraftTitle}
            onToggleScope={teaching.toggleReviewScope}
            onLocateCard={teaching.locateCardEvidence}
          />
        ) : null}

        {isLibrary ? (
          <TeachingSavedAssets
            assets={teaching.savedAssets}
            selectedAsset={teaching.selectedSavedAsset}
            isLoading={teaching.savedAssetsLoading}
            isDetailLoading={teaching.savedAssetDetailLoading}
            onOpenAsset={teaching.openSavedAsset}
            onBackToList={teaching.closeSavedAssetDetail}
          />
        ) : null}
      </div>

      {isRecording ? (
        <TeachingComposer
          mode={teaching.mode}
          value={teaching.noteDraft}
          placeholder="补充你的意图、判断、提醒或背景信息"
          buttonLabel="添加备注"
          onChange={teaching.setNoteDraft}
          onSubmit={teaching.submitNote}
        />
      ) : null}

      {isReview && teaching.reviewScope === "draft" && !teaching.savedAt ? (
        <TeachingComposer
          mode={teaching.mode}
          value={teaching.revisionDraft}
          placeholder="用自然语言修正这份流程草稿"
          buttonLabel="提交修订"
          onChange={teaching.setRevisionDraft}
          onSubmit={teaching.submitRevision}
        />
      ) : null}
    </div>
  );
}
