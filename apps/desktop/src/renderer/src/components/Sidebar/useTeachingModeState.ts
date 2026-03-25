import { useEffect, useRef, useState } from "react";
import {
  TeachingContextSnapshot,
  TeachingDraftSnapshot,
  TeachingProcessingOverview,
  TeachingProcessingStep,
  TeachingReviewCard,
  TeachingReviewScope,
  TeachingSavedAssetDetail,
  TeachingSavedAssetSummary,
  TeachingTimelineItem,
  TeachingViewMode,
} from "./teachingTypes";

type NativeTeachingStateSnapshot = Awaited<
  ReturnType<typeof window.api.teachingGetState>
>;
type NativeTeachingSession = NonNullable<
  NativeTeachingStateSnapshot["activeSession"]
>;
type NativeTeachingTimelineItem = NativeTeachingSession["timeline"][number];
type NativeTeachingArtifact = NativeTeachingSession["artifacts"][number];

type TeachingSocketPayload = Record<string, unknown>;
type SendTeachingPayload = (payload: TeachingSocketPayload) => boolean;

const PROCESSING_STEPS: Array<{ id: string; label: string; description: string }> = [
  {
    id: "digest",
    label: "整理教学记录",
    description: "压缩低价值内容，保留关键教学语料。",
  },
  {
    id: "segment",
    label: "识别阶段边界",
    description: "判断哪些操作属于同一个教学阶段。",
  },
  {
    id: "goal",
    label: "提炼每阶段目标",
    description: "归纳每一段真正想完成的事情。",
  },
  {
    id: "cards",
    label: "生成流程卡片",
    description: "输出可审阅、可修订的分阶段列表。",
  },
];

const stepMetaById = Object.fromEntries(
  PROCESSING_STEPS.map((step) => [step.id, step]),
) as Record<string, { id: string; label: string; description: string }>;

const ACTION_TITLES: Record<string, string> = {
  click: "点击操作",
  input: "输入内容",
  change: "修改字段",
  submit: "提交操作",
  navigate: "页面跳转",
  navigate_in_page: "页面内跳转",
  load: "页面加载",
  tab_select: "激活标签页",
  tab_switch_ignored: "忽略切换标签页",
};

const nowIso = () => new Date().toISOString();

const uid = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const buildDraftTitle = (context: TeachingContextSnapshot) => {
  const base = context.title?.trim() || "当前页面";
  return `${base} 教学草稿`;
};

const formatClock = (startedAt?: number | null) => {
  if (!startedAt) return "00:00";
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
};

const createProcessingSteps = (): TeachingProcessingStep[] =>
  PROCESSING_STEPS.map((step, index) => ({
    ...step,
    state: index === 0 ? "active" : "pending",
  }));

const formatDetail = (detail: unknown): string | undefined => {
  if (!detail) return undefined;
  if (typeof detail === "string") return detail.trim() || undefined;
  if (typeof detail !== "object") return undefined;

  const record = detail as Record<string, unknown>;
  const highSignal = [
    record.pageChangeSummary,
    record.reason,
    record.activeUrl,
    record.url,
    record.source,
    record.error,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  if (highSignal.length > 0) {
    return highSignal.join(" · ");
  }

  try {
    return JSON.stringify(record);
  } catch {
    return undefined;
  }
};

const mapSessionContext = (
  session: NativeTeachingSession,
  fallback: TeachingContextSnapshot,
): TeachingContextSnapshot => ({
  tabId: session.lockedTabId ?? fallback.tabId ?? null,
  title: session.lockedTabTitle || fallback.title,
  url: session.lockedTabUrl || fallback.url,
});

const mapTimelineItem = (
  item: NativeTeachingTimelineItem,
  artifactById: Map<string, NativeTeachingArtifact>,
): TeachingTimelineItem => {
  const artifact = item.artifactId ? artifactById.get(item.artifactId) : undefined;
  const kind =
    item.kind === "note" || item.kind === "system" ? item.kind : "action";

  return {
    id: item.id,
    kind,
    title:
      kind === "note"
        ? "用户备注"
        : kind === "system"
          ? "系统记录"
          : ACTION_TITLES[item.actionType || ""] || "浏览器操作",
    description: item.summary,
    timestamp: item.createdAt,
    detail: formatDetail(item.detail),
    artifactPath: artifact?.path,
    badge: kind === "system" ? "system" : undefined,
  };
};

const mapSessionTimeline = (session: NativeTeachingSession): TeachingTimelineItem[] => {
  const artifactById = new Map<string, NativeTeachingArtifact>();
  for (const artifact of session.artifacts || []) {
    artifactById.set(artifact.id, artifact);
  }
  return (session.timeline || []).map((item) => mapTimelineItem(item, artifactById));
};

const formatEvidence = (refs: unknown): string => {
  if (!Array.isArray(refs) || refs.length === 0) return "待补充";
  return refs
    .map((ref) => {
      if (!ref || typeof ref !== "object") return "";
      const record = ref as Record<string, unknown>;
      const type = String(record.type || "").trim();
      if (type === "timeline_range") {
        const start = String(record.startItemId || record.start_item_id || "").trim();
        const end = String(record.endItemId || record.end_item_id || "").trim();
        return start && end ? `${start} → ${end}` : start || end;
      }
      if (type === "timeline_item") {
        return String(record.itemId || record.item_id || "").trim();
      }
      if (type === "artifact") {
        return String(record.artifactId || record.artifact_id || "").trim();
      }
      return "";
    })
    .filter(Boolean)
    .join(" · ");
};

const mapDraftCards = (draft: any): TeachingReviewCard[] => {
  const cards = Array.isArray(draft?.cards) ? draft.cards : [];
  return cards.map((card: any) => ({
    id: String(card.cardId || card.id || uid()),
    title: String(card.title || "阶段卡片"),
    goal: String(card.goal || ""),
    keyActions: Array.isArray(card.keyActions)
      ? card.keyActions.map((value: unknown) => String(value))
      : Array.isArray(card.key_actions)
        ? card.key_actions.map((value: unknown) => String(value))
        : [],
    evidence: formatEvidence(card.evidenceRefs || card.evidence_refs),
  }));
};

const mapSavedAssetSummary = (asset: any): TeachingSavedAssetSummary => ({
  id: String(asset.assetId || asset.id || uid()),
  title: String(asset.title || "未命名流程"),
  createdAt: String(asset.createdAt || asset.created_at || nowIso()),
  cardCount: Number(asset.cardCount || asset.card_count || 0),
  status: String(asset.status || "saved"),
  visibility: String(asset.visibility || "private"),
  sourceTitle: String(asset.sourceTitle || asset.source_title || "").trim() || undefined,
  sourceUrl: String(asset.sourceUrl || asset.source_url || "").trim() || undefined,
  sourceDomain:
    String(asset.sourceDomain || asset.source_domain || "").trim() || undefined,
});

const mapSavedAssetDetail = (asset: any): TeachingSavedAssetDetail => ({
  ...mapSavedAssetSummary(asset),
  teachingSessionId:
    String(asset.teachingSessionId || asset.teaching_session_id || "").trim() ||
    undefined,
  sourceDraftId:
    String(asset.sourceDraftId || asset.source_draft_id || "").trim() || undefined,
  cards: mapDraftCards({ cards: asset.cards || [] }),
});

const updateProcessingSteps = (
  previous: TeachingProcessingStep[],
  stepPayload: { id?: string; label?: string; status?: string },
): TeachingProcessingStep[] => {
  const stepId = String(stepPayload.id || "").trim();
  const stepStatus = String(stepPayload.status || "").trim();
  if (!stepId || !stepStatus) return previous;

  return previous.map((step) => {
    if (step.id !== stepId) {
      if (
        stepStatus === "running" &&
        PROCESSING_STEPS.findIndex((item) => item.id === step.id) <
          PROCESSING_STEPS.findIndex((item) => item.id === stepId)
      ) {
        return { ...step, state: "done" };
      }
      return step;
    }

    return {
      ...step,
      label: stepPayload.label ? String(stepPayload.label) : step.label,
      state:
        stepStatus === "done"
          ? "done"
          : stepStatus === "running"
            ? "active"
            : "pending",
    };
  });
};

const buildDraftSummary = (cardCount: number) =>
  cardCount > 0
    ? `已整理出 ${cardCount} 个阶段卡片，等待审阅。`
    : "当前还没有生成可审阅的流程卡片。";

const buildProcessingOverviewSummary = (
  overview: TeachingProcessingOverview | null,
) => {
  if (!overview) return "等待开始整理教学数据。";
  return `已接收 ${overview.actionItems} 条操作、${overview.noteItems} 条备注、${overview.artifactCount} 个变化文件。`;
};

const buildProcessingFeedItem = ({
  kind = "system",
  title,
  description,
  detail,
  createdAt,
  badge,
}: {
  kind?: TeachingTimelineItem["kind"];
  title: string;
  description: string;
  detail?: string;
  createdAt?: string;
  badge?: string;
}): TeachingTimelineItem => ({
  id: uid(),
  kind,
  title,
  description,
  timestamp: createdAt || nowIso(),
  detail,
  badge,
});

export interface TeachingModeState {
  mode: TeachingViewMode;
  reviewScope: TeachingReviewScope;
  context: TeachingContextSnapshot;
  timeline: TeachingTimelineItem[];
  highlightedItemIds: string[];
  draft: TeachingDraftSnapshot;
  reviewCards: TeachingReviewCard[];
  processingSteps: TeachingProcessingStep[];
  processingOverview: TeachingProcessingOverview | null;
  processingFeed: TeachingTimelineItem[];
  savedAssets: TeachingSavedAssetSummary[];
  selectedSavedAsset: TeachingSavedAssetDetail | null;
  savedAssetsLoading: boolean;
  savedAssetDetailLoading: boolean;
  noteDraft: string;
  revisionDraft: string;
  startedAt: number | null;
  elapsedLabel: string;
  savedAt: string | null;
  canSaveDraft: boolean;
  isSavingDraft: boolean;
  beginTeaching: () => void;
  cancelTeaching: () => void;
  stopTeaching: () => void;
  exitTeaching: () => void;
  setNoteDraft: (value: string) => void;
  setRevisionDraft: (value: string) => void;
  setDraftTitle: (value: string) => void;
  submitNote: () => void;
  submitRevision: () => void;
  locateCardEvidence: (cardId: string) => void;
  setReviewScope: (scope: TeachingReviewScope) => void;
  toggleReviewScope: () => void;
  saveDraft: () => void;
  openSavedAssets: () => void;
  closeSavedAssets: () => void;
  openSavedAsset: (assetId: string) => void;
  closeSavedAssetDetail: () => void;
  ingestSocketEvent: (payload: any) => void;
  openTeachingSetup: () => void;
}

export function useTeachingModeState(
  currentTabContext: TeachingContextSnapshot,
  sendTeachingPayload: SendTeachingPayload,
): TeachingModeState {
  const [mode, setMode] = useState<TeachingViewMode>("chat");
  const [reviewScope, setReviewScope] = useState<TeachingReviewScope>("draft");
  const [teachingContext, setTeachingContext] =
    useState<TeachingContextSnapshot>(currentTabContext);
  const [timeline, setTimeline] = useState<TeachingTimelineItem[]>([]);
  const [highlightedItemIds, setHighlightedItemIds] = useState<string[]>([]);
  const [draft, setDraft] = useState<TeachingDraftSnapshot>({
    title: buildDraftTitle(currentTabContext),
    summary: "等待开始教学。",
  });
  const [reviewCards, setReviewCards] = useState<TeachingReviewCard[]>([]);
  const [processingSteps, setProcessingSteps] = useState<TeachingProcessingStep[]>(
    PROCESSING_STEPS.map((step) => ({ ...step, state: "pending" })),
  );
  const [processingOverview, setProcessingOverview] =
    useState<TeachingProcessingOverview | null>(null);
  const [processingFeed, setProcessingFeed] = useState<TeachingTimelineItem[]>([]);
  const [savedAssets, setSavedAssets] = useState<TeachingSavedAssetSummary[]>([]);
  const [selectedSavedAsset, setSelectedSavedAsset] =
    useState<TeachingSavedAssetDetail | null>(null);
  const [savedAssetsLoading, setSavedAssetsLoading] = useState(false);
  const [savedAssetDetailLoading, setSavedAssetDetailLoading] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [revisionDraft, setRevisionDraft] = useState("");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedLabel, setElapsedLabel] = useState("00:00");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [currentDraftId, setCurrentDraftId] = useState<string | null>(null);

  const currentTabContextRef = useRef(currentTabContext);
  const modeRef = useRef<TeachingViewMode>("chat");
  const currentSessionIdRef = useRef<string | null>(null);
  const timelineRef = useRef<TeachingTimelineItem[]>([]);
  const libraryReturnModeRef = useRef<Extract<TeachingViewMode, "setup" | "review">>(
    "setup",
  );

  useEffect(() => {
    currentTabContextRef.current = currentTabContext;
    if (modeRef.current === "chat" || modeRef.current === "setup") {
      setTeachingContext(currentTabContext);
      setDraft((previous) => ({
        ...previous,
        title: buildDraftTitle(currentTabContext),
      }));
    }
  }, [currentTabContext]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  useEffect(() => {
    timelineRef.current = timeline;
  }, [timeline]);

  useEffect(() => {
    if (mode !== "recording" || !startedAt) {
      setElapsedLabel("00:00");
      return;
    }

    const tick = () => setElapsedLabel(formatClock(startedAt));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [mode, startedAt]);

  const resetToChat = (nextContext?: TeachingContextSnapshot) => {
    const context = nextContext || currentTabContextRef.current;
    setMode("chat");
    setReviewScope("draft");
    setTeachingContext(context);
    setTimeline([]);
    setHighlightedItemIds([]);
    setReviewCards([]);
    setProcessingSteps(PROCESSING_STEPS.map((step) => ({ ...step, state: "pending" })));
    setProcessingOverview(null);
    setProcessingFeed([]);
    setSavedAssets([]);
    setSelectedSavedAsset(null);
    setSavedAssetsLoading(false);
    setSavedAssetDetailLoading(false);
    setDraft({
      title: buildDraftTitle(context),
      summary: "等待开始教学。",
    });
    setNoteDraft("");
    setRevisionDraft("");
    setStartedAt(null);
    setElapsedLabel("00:00");
    setSavedAt(null);
    setIsSavingDraft(false);
    setCurrentSessionId(null);
    setCurrentDraftId(null);
  };

  const applyNativeSession = (session: NativeTeachingSession) => {
    setCurrentSessionId(session.id);
    setTeachingContext(mapSessionContext(session, currentTabContextRef.current));
    setTimeline(mapSessionTimeline(session));
    setStartedAt(session.startedAt ? Date.parse(session.startedAt) : null);
  };

  const beginTeaching = () => {
    void (async () => {
      try {
        const snapshot = await window.api.teachingStart();
        if (!snapshot.activeSession) {
          throw new Error("当前没有可用的浏览器标签页。");
        }
        applyNativeSession(snapshot.activeSession);
        setSavedAt(null);
        setIsSavingDraft(false);
        setReviewScope("draft");
        setReviewCards([]);
        setProcessingOverview(null);
        setProcessingFeed([]);
        setSelectedSavedAsset(null);
        setSavedAssetsLoading(false);
        setSavedAssetDetailLoading(false);
        setDraft({
          title: buildDraftTitle(
            mapSessionContext(snapshot.activeSession, currentTabContextRef.current),
          ),
          summary: "教学已开始，等待用户继续操作和备注。",
        });
        setMode("recording");
      } catch (error) {
        setDraft({
          title: buildDraftTitle(currentTabContextRef.current),
          summary:
            error instanceof Error
              ? error.message
              : "开始教学失败，请稍后重试。",
        });
      }
    })();
  };

  const openTeachingSetup = () => {
    setMode("setup");
    setReviewScope("draft");
    setTeachingContext(currentTabContextRef.current);
    setDraft({
      title: buildDraftTitle(currentTabContextRef.current),
      summary: "等待开始教学。",
    });
    setReviewCards([]);
    setTimeline([]);
    setProcessingOverview(null);
    setProcessingFeed([]);
    setSelectedSavedAsset(null);
    setSavedAssetsLoading(false);
    setSavedAssetDetailLoading(false);
    setSavedAt(null);
    setIsSavingDraft(false);
    setStartedAt(null);
    setCurrentDraftId(null);
  };

  const openSavedAssets = () => {
    libraryReturnModeRef.current = modeRef.current === "review" ? "review" : "setup";
    setMode("library");
    setSelectedSavedAsset(null);
    setSavedAssetDetailLoading(false);
    setSavedAssetsLoading(true);
    setDraft((previous) => ({
      ...previous,
      summary: "正在加载已保存教学。",
    }));

    const sent = sendTeachingPayload({
      type: "teaching_list_assets",
    });

    if (!sent) {
      setSavedAssetsLoading(false);
      setDraft((previous) => ({
        ...previous,
        summary: "Brain 尚未连接，暂时无法读取已保存教学。",
      }));
    }
  };

  const closeSavedAssets = () => {
    setSelectedSavedAsset(null);
    setSavedAssetDetailLoading(false);
    setMode(libraryReturnModeRef.current);
    if (libraryReturnModeRef.current === "setup") {
      setDraft({
        title: buildDraftTitle(currentTabContextRef.current),
        summary: "等待开始教学。",
      });
    } else {
      setDraft((previous) => ({
        ...previous,
        summary: buildDraftSummary(reviewCards.length),
      }));
    }
  };

  const openSavedAsset = (assetId: string) => {
    if (!assetId) return;
    setSavedAssetDetailLoading(true);
    const sent = sendTeachingPayload({
      type: "teaching_get_asset",
      asset_id: assetId,
    });
    if (!sent) {
      setSavedAssetDetailLoading(false);
      setDraft((previous) => ({
        ...previous,
        summary: "Brain 尚未连接，暂时无法读取教学详情。",
      }));
    }
  };

  const closeSavedAssetDetail = () => {
    setSelectedSavedAsset(null);
    setSavedAssetDetailLoading(false);
    setDraft((previous) => ({
      ...previous,
      summary:
        savedAssets.length > 0
          ? `共找到 ${savedAssets.length} 条已保存教学。`
          : "当前还没有已保存教学。",
    }));
  };

  const cancelTeaching = () => {
    resetToChat();
  };

  const exitTeaching = () => {
    if (modeRef.current !== "recording") {
      resetToChat();
      return;
    }

    const confirmed = window.confirm("退出教学会结束当前记录。是否继续？");
    if (!confirmed) return;

    void (async () => {
      try {
        await window.api.teachingStop();
      } catch {
        // Ignore local stop failures when the user is explicitly abandoning the session.
      } finally {
        resetToChat();
      }
    })();
  };

  const stopTeaching = () => {
    if (modeRef.current !== "recording") return;

    void (async () => {
      try {
        const snapshot = await window.api.teachingStop();
        const session = snapshot.activeSession;
        if (!session) {
          throw new Error("未找到当前教学会话。");
        }

        applyNativeSession(session);
        setMode("processing");
        setProcessingSteps(createProcessingSteps());
        setProcessingOverview(null);
        setProcessingFeed([]);
        setIsSavingDraft(false);
        setDraft({
          title: buildDraftTitle(mapSessionContext(session, currentTabContextRef.current)),
          summary: "正在整理教学记录，请稍候。",
        });

        const sent = sendTeachingPayload({
          type: "teaching_stop",
          teaching_session_id: session.id,
          session_snapshot: snapshot,
          instruction: "请根据当前教学数据生成第一版流程草稿。",
        });

        if (!sent) {
          setMode("review");
          setReviewScope("raw_record");
          setDraft((previous) => ({
            ...previous,
            summary: "Brain 尚未连接，当前只能查看原始教学记录。",
          }));
        }
      } catch (error) {
        setDraft((previous) => ({
          ...previous,
          summary:
            error instanceof Error
              ? error.message
              : "停止教学失败，请稍后重试。",
        }));
      }
    })();
  };

  const submitNote = () => {
    const text = noteDraft.trim();
    if (!text) return;

    void (async () => {
      try {
        await window.api.teachingAddNote({ text });
        setNoteDraft("");
      } catch (error) {
        setDraft((previous) => ({
          ...previous,
          summary:
            error instanceof Error
              ? error.message
              : "添加备注失败，请稍后重试。",
        }));
      }
    })();
  };

  const submitRevision = () => {
    const instruction = revisionDraft.trim();
    if (!instruction || !currentSessionIdRef.current) return;

    const sent = sendTeachingPayload({
      type: "teaching_revise",
      teaching_session_id: currentSessionIdRef.current,
      draft_id: currentDraftId || undefined,
      instruction,
    });

    if (!sent) {
      setDraft((previous) => ({
        ...previous,
        summary: "Brain 尚未连接，暂时无法提交修订。",
      }));
      return;
    }

    setRevisionDraft("");
    setMode("processing");
    setProcessingSteps(createProcessingSteps());
    setProcessingOverview(null);
    setProcessingFeed([]);
    setIsSavingDraft(false);
    setDraft((previous) => ({
      ...previous,
      summary: "正在根据你的修订意见重整流程草稿。",
    }));
  };

  const setDraftTitle = (value: string) => {
    setDraft((previous) => ({
      ...previous,
      title: value,
    }));
  };

  const saveDraft = () => {
    if (!currentSessionIdRef.current) {
      setDraft((previous) => ({
        ...previous,
        summary: "当前教学会话已失效，请重新开始教学后再保存。",
      }));
      return;
    }

    if (!currentDraftId) {
      setDraft((previous) => ({
        ...previous,
        summary: "当前还没有可保存的流程草稿，请先等待卡片生成完成。",
      }));
      return;
    }

    const suggestedTitle = draft.title || buildDraftTitle(teachingContext);
    const finalTitle = String(suggestedTitle).trim() || buildDraftTitle(teachingContext);
    const sent = sendTeachingPayload({
      type: "teaching_save",
      teaching_session_id: currentSessionIdRef.current,
      draft_id: currentDraftId,
      title: finalTitle,
    });

    if (!sent) {
      setDraft((previous) => ({
        ...previous,
        summary: "Brain 尚未连接，暂时无法保存流程。",
      }));
      return;
    }

    setIsSavingDraft(true);
    setDraft((previous) => ({
      ...previous,
      title: finalTitle,
      summary: "正在保存流程。",
    }));
  };

  const locateCardEvidence = (cardId: string) => {
    if (!currentSessionIdRef.current || !currentDraftId || !cardId) return;

    const sent = sendTeachingPayload({
      type: "teaching_locate",
      teaching_session_id: currentSessionIdRef.current,
      draft_id: currentDraftId,
      card_id: cardId,
    });

    if (!sent) {
      setDraft((previous) => ({
        ...previous,
        summary: "Brain 尚未连接，暂时无法定位原始记录。",
      }));
    }
  };

  const toggleReviewScope = () => {
    setReviewScope((previous) => {
      const nextScope = previous === "draft" ? "raw_record" : "draft";
      if (nextScope === "draft") {
        setHighlightedItemIds([]);
      }
      return nextScope;
    });
  };

  const appendProcessingFeedEntry = (entry: TeachingTimelineItem) => {
    setProcessingFeed((previous) => [...previous, entry]);
  };

  const appendProcessingLogEntry = (payload: any) => {
    const stepId = String(payload.stepId || payload.step_id || "").trim();
    const stepMeta = stepMetaById[stepId];
    const title = String(payload.label || payload.title || stepMeta?.label || "处理中").trim();
    const description = String(payload.detail || payload.description || "").trim();
    appendProcessingFeedEntry(
      buildProcessingFeedItem({
        kind: "system",
        title,
        description: description || "AI 正在继续整理教学数据。",
        createdAt: String(payload.createdAt || payload.created_at || "").trim() || undefined,
        badge: stepMeta?.label || undefined,
      }),
    );
  };

  const appendProcessingFindingEntry = (payload: any) => {
    const stepId = String(payload.stepId || payload.step_id || "").trim();
    const stepMeta = stepMetaById[stepId];
    const title = String(payload.title || payload.label || "处理中发现").trim();
    const summary = String(payload.summary || payload.detail || "").trim();
    appendProcessingFeedEntry(
      buildProcessingFeedItem({
        kind: "finding",
        title,
        description: summary || "AI 刚刚确认了一条新的处理中发现。",
        createdAt: String(payload.createdAt || payload.created_at || "").trim() || undefined,
        badge: stepMeta?.label || "发现",
      }),
    );
  };

  const resolveHighlightedIds = (payload: any) => {
    const anchors = Array.isArray(payload?.timelineAnchors)
      ? payload.timelineAnchors
      : [];
    if (!anchors.length) return [];

    const timelineItems = timelineRef.current;
    const ids = timelineItems.map((item) => item.id);
    const highlighted = new Set<string>();

    for (const anchor of anchors) {
      if (!anchor || typeof anchor !== "object") continue;
      const startItemId = String(anchor.startItemId || "").trim();
      const endItemId = String(anchor.endItemId || "").trim();
      if (!startItemId) continue;
      const startIndex = ids.indexOf(startItemId);
      if (startIndex === -1) continue;
      const endIndex = endItemId ? ids.indexOf(endItemId) : startIndex;
      const safeEndIndex = endIndex >= startIndex ? endIndex : startIndex;
      for (let index = startIndex; index <= safeEndIndex; index += 1) {
        highlighted.add(ids[index]);
      }
    }

    return Array.from(highlighted);
  };

  const ingestSocketEvent = (payload: any) => {
    if (!payload || typeof payload !== "object") return;
    const type = String(payload.type || "");
    if (!type.startsWith("teaching_")) return;

    const payloadSessionId = String(
      payload.teachingSessionId ||
        payload.sessionId ||
        payload.teachingSession?.id ||
        "",
    ).trim();

    if (
      payloadSessionId &&
      currentSessionIdRef.current &&
      payloadSessionId !== currentSessionIdRef.current
    ) {
      return;
    }

    if (!currentSessionIdRef.current && modeRef.current === "chat") {
      return;
    }

    if (!currentSessionIdRef.current && payloadSessionId) {
      setCurrentSessionId(payloadSessionId);
    }

    if (type === "teaching_saved_assets") {
      const assets = Array.isArray(payload.assets)
        ? payload.assets.map((asset: unknown) => mapSavedAssetSummary(asset))
        : [];
      setSavedAssets(assets);
      setSavedAssetsLoading(false);
      setSavedAssetDetailLoading(false);
      setSelectedSavedAsset(null);
      setMode("library");
      setDraft((previous) => ({
        ...previous,
        summary:
          assets.length > 0
            ? `共找到 ${assets.length} 条已保存教学。`
            : "当前还没有已保存教学。",
      }));
      return;
    }

    if (type === "teaching_saved_asset_detail") {
      const asset = payload.asset ? mapSavedAssetDetail(payload.asset) : null;
      setSelectedSavedAsset(asset);
      setSavedAssetDetailLoading(false);
      setMode("library");
      setDraft((previous) => ({
        ...previous,
        summary: asset
          ? `正在查看“${asset.title}”的已保存教学内容。`
          : "未找到对应的已保存教学。",
      }));
      return;
    }

    if (type === "teaching_session") {
      const session = payload.teachingSession;
      if (session && typeof session === "object" && Array.isArray(session.timeline)) {
        applyNativeSession(session as NativeTeachingSession);
      }
      return;
    }

    if (type === "teaching_processing_step") {
      setMode("processing");
      setProcessingSteps((previous) =>
        updateProcessingSteps(previous, payload.step as Record<string, unknown>),
      );
      const stepPayload = payload.step as Record<string, unknown>;
      const stepId = String(stepPayload?.id || "").trim();
      const stepStatus = String(stepPayload?.status || "").trim();
      const stepMeta = stepMetaById[stepId];
      if (stepStatus === "running" || stepStatus === "done") {
        appendProcessingFeedEntry(
          buildProcessingFeedItem({
            kind: "system",
            title: String(stepPayload?.label || stepMeta?.label || "处理中"),
            description:
              stepStatus === "done"
                ? "当前阶段已完成，正在继续推进后续整理。"
                : stepMeta?.description || "AI 正在继续整理教学数据。",
            createdAt: nowIso(),
            badge: stepMeta?.label || undefined,
          }),
        );
      }
      return;
    }

    if (type === "teaching_processing_started") {
      const stats = payload.stats && typeof payload.stats === "object" ? payload.stats : {};
      const nextOverview: TeachingProcessingOverview = {
        taskType: String(payload.taskType || "").trim() || undefined,
        totalItems: Number(stats.totalItems || 0),
        actionItems: Number(stats.actionItems || 0),
        noteItems: Number(stats.noteItems || 0),
        artifactCount: Number(stats.artifactCount || 0),
      };
      setMode("processing");
      setProcessingOverview(nextOverview);
      appendProcessingFeedEntry(
        buildProcessingFeedItem({
          kind: "system",
          title: "已接收教学记录",
          description: buildProcessingOverviewSummary(nextOverview),
          createdAt: String(payload.createdAt || "").trim() || undefined,
          badge: nextOverview.taskType === "revise_draft" ? "修订" : "整理",
        }),
      );
      return;
    }

    if (type === "teaching_processing_log") {
      appendProcessingLogEntry(payload);
      return;
    }

    if (type === "teaching_processing_finding") {
      appendProcessingFindingEntry(payload);
      return;
    }

    if (type === "teaching_draft_updated") {
      const nextDraft = payload.draft || {};
      const cards = mapDraftCards(nextDraft);
      setCurrentDraftId(String(nextDraft.draftId || nextDraft.id || ""));
      setReviewCards(cards);
      setHighlightedItemIds([]);
      setSavedAt(null);
      setIsSavingDraft(false);
      setDraft({
        title: String(nextDraft.title || buildDraftTitle(teachingContext)),
        summary: buildDraftSummary(cards.length),
      });
      setMode("review");
      setReviewScope("draft");
      return;
    }

    if (type === "teaching_agent_message") {
      const content = String(payload.content || payload.message || "").trim();
      if (!content) return;
      setIsSavingDraft(false);
      if (modeRef.current === "processing") {
        appendProcessingFeedEntry(
          buildProcessingFeedItem({
            kind: "system",
            title: "处理中反馈",
            description: content,
            createdAt: nowIso(),
            badge: "反馈",
          }),
        );
      }
      setDraft((previous) => ({
        ...previous,
        summary: content,
      }));
      return;
    }

    if (type === "teaching_card_evidence") {
      setHighlightedItemIds(resolveHighlightedIds(payload.payload));
      setReviewScope("raw_record");
      return;
    }

    if (type === "teaching_asset_saved") {
      setSavedAt(nowIso());
      setIsSavingDraft(false);
      setMode("review");
      setReviewScope("draft");
      setDraft((previous) => ({
        ...previous,
        summary: "流程已保存，未来相似任务可作为推荐流程使用。",
      }));
      return;
    }

    if (type === "teaching_result") {
      if (payload.draft) {
        const cards = mapDraftCards(payload.draft);
        setCurrentDraftId(String(payload.draft.id || payload.draft.draftId || ""));
        setReviewCards(cards);
        if (payload.taskType !== "save_asset") {
          setSavedAt(null);
          setDraft({
            title: String(payload.draft.title || buildDraftTitle(teachingContext)),
            summary: buildDraftSummary(cards.length),
          });
        } else {
          setIsSavingDraft(false);
          setDraft((previous) => ({
            ...previous,
            title:
              String(payload.draft.title || "").trim() ||
              previous.title ||
              buildDraftTitle(teachingContext),
          }));
        }
        setHighlightedItemIds([]);
        setMode("review");
        setReviewScope("draft");
      }
      return;
    }

    if (type === "teaching_error") {
      setIsSavingDraft(false);
      setSavedAssetsLoading(false);
      setSavedAssetDetailLoading(false);
      if (modeRef.current === "library") {
        setDraft((previous) => ({
          ...previous,
          summary: String(payload.error || "读取已保存教学失败，请稍后重试。"),
        }));
        return;
      }
      setDraft((previous) => ({
        ...previous,
        summary: String(payload.error || "教学整理失败，请稍后重试。"),
      }));
      setMode("review");
      setReviewScope("raw_record");
    }
  };

  useEffect(() => {
    const offState = window.api.onTeachingState((snapshot) => {
      const activeSession = snapshot.activeSession;
      if (!activeSession || !currentSessionIdRef.current) return;
      if (activeSession.id !== currentSessionIdRef.current) return;
      applyNativeSession(activeSession);
    });

    const offEvent = window.api.onTeachingEvent((payload) => {
      const sessionId = String(payload.sessionId || "").trim();
      if (!sessionId || sessionId !== currentSessionIdRef.current) return;

      if (payload.type === "timeline_item" && payload.item) {
        window.api
          .teachingGetState()
          .then((snapshot) => {
            if (snapshot.activeSession?.id === currentSessionIdRef.current) {
              applyNativeSession(snapshot.activeSession);
            }
          })
          .catch(() => {});
      }

      if (payload.type === "artifact_captured" && payload.item) {
        window.api
          .teachingGetState()
          .then((snapshot) => {
            if (snapshot.activeSession?.id === currentSessionIdRef.current) {
              applyNativeSession(snapshot.activeSession);
            }
          })
          .catch(() => {});
      }
    });

    const offError = window.api.onTeachingError((payload) => {
      setDraft((previous) => ({
        ...previous,
        summary: payload.error
          ? `${payload.message} ${payload.error}`
          : payload.message,
      }));
    });

    return () => {
      offState();
      offEvent();
      offError();
    };
  }, []);

  return {
    mode,
    reviewScope,
    context: teachingContext,
    timeline,
    highlightedItemIds,
    draft,
    reviewCards,
    processingSteps,
    processingOverview,
    processingFeed,
    savedAssets,
    selectedSavedAsset,
    savedAssetsLoading,
    savedAssetDetailLoading,
    noteDraft,
    revisionDraft,
    startedAt,
    elapsedLabel,
    savedAt,
    canSaveDraft: Boolean(currentSessionId && currentDraftId),
    isSavingDraft,
    beginTeaching,
    cancelTeaching,
    stopTeaching,
    exitTeaching,
    setNoteDraft,
    setRevisionDraft,
    setDraftTitle,
    submitNote,
    submitRevision,
    locateCardEvidence,
    setReviewScope,
    toggleReviewScope,
    saveDraft,
    openSavedAssets,
    closeSavedAssets,
    openSavedAsset,
    closeSavedAssetDetail,
    ingestSocketEvent,
    openTeachingSetup,
  };
}
