import React from "react";
import { TeachingComposer } from "./TeachingComposer";
import { TeachingHeader } from "./TeachingHeader";
import { TeachingReview } from "./TeachingReview";
import { TeachingSavedAssets } from "./TeachingSavedAssets";
import { TeachingTimeline } from "./TeachingTimeline";
import { TeachingModeState } from "./useTeachingModeState";

interface TeachingWorkspaceProps {
  teaching: TeachingModeState;
}

export function TeachingWorkspace({ teaching }: TeachingWorkspaceProps) {
  const isSetup = teaching.mode === "setup";
  const isRecording = teaching.mode === "recording";
  const isProcessing = teaching.mode === "processing";
  const isReview = teaching.mode === "review";
  const isLibrary = teaching.mode === "library";
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
        {isSetup ? (
          <div className="rounded-[24px] border border-[color:var(--border-soft)] bg-[linear-gradient(180deg,rgba(255,255,255,0.18)_0%,rgba(255,255,255,0.06)_100%)] p-4 shadow-[var(--shadow-soft)]">
            <div className="text-[10px] uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">
              Teaching setup
            </div>
            <div className="mt-2 text-[15px] font-semibold text-[color:var(--text-primary)]">
              进入教学模式前，先确认当前浏览器标签页。
            </div>
            <div className="mt-2 text-[12px] leading-5 text-[color:var(--text-secondary)]">
              这一步不会打断当前浏览器工作区。开始学习后，右侧会切换成单向时间流水线，只记录当前标签页中的操作和备注。
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
            <div className="space-y-2.5">
              {teaching.processingSteps.map((step) => (
                <div
                  key={step.id}
                  className={`rounded-[18px] border px-3.5 py-3 ${
                    step.state === "active"
                      ? "border-[color:var(--field-border-strong)] bg-[var(--field-focus-ring)]"
                      : step.state === "done"
                        ? "border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/86"
                        : "border-[color:var(--border-soft)] bg-[linear-gradient(180deg,rgba(255,255,255,0.14)_0%,rgba(255,255,255,0.04)_100%)]"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div className="flex h-6 w-6 items-center justify-center rounded-full border border-[color:var(--border-soft)] bg-[var(--shell-surface-strong)]/90 text-[10px] font-semibold text-[color:var(--text-primary)]">
                      {step.state === "done" ? "✓" : step.state === "active" ? "…" : "·"}
                    </div>
                    <div className="text-[13px] font-semibold text-[color:var(--text-primary)]">
                      {step.label}
                    </div>
                  </div>
                  <div className="mt-1 pl-8 text-[12px] leading-5 text-[color:var(--text-secondary)]">
                    {step.description}
                  </div>
                </div>
              ))}
            </div>

            <div className="rounded-[22px] border border-[color:var(--border-soft)] bg-[linear-gradient(180deg,rgba(255,255,255,0.18)_0%,rgba(255,255,255,0.06)_100%)] p-3 shadow-[var(--shadow-soft)]">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">
                    AI 处理日志
                  </div>
                  <div className="mt-1 text-[14px] font-semibold text-[color:var(--text-primary)]">
                    AI 正在按时间顺序整理这次教学数据
                  </div>
                  <div className="mt-1 text-[12px] leading-5 text-[color:var(--text-secondary)]">
                    原始教学记录已保留。下面只展示 AI 可解释的调查动作和中间发现，不展示模型内部思维文本。
                  </div>
                </div>
              </div>

              {teaching.processingOverview ? (
                <div className="mt-3 flex flex-wrap gap-2">
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

              <div className="mt-3">
                <TeachingTimeline items={teaching.processingFeed} variant="processing" />
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

      {isReview && !teaching.savedAt ? (
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
