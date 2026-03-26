export type TeachingViewMode =
  | "chat"
  | "setup"
  | "recording"
  | "processing"
  | "review"
  | "library";

export type TeachingReviewScope = "draft" | "raw_record";

export type TeachingTimelineItemKind =
  | "action"
  | "note"
  | "artifact"
  | "system"
  | "finding";

export type TeachingProcessingStepState = "done" | "active" | "pending";

export interface TeachingContextSnapshot {
  tabId?: number | null;
  title?: string;
  url?: string;
}

export interface TeachingTimelineItem {
  id: string;
  kind: TeachingTimelineItemKind;
  title: string;
  description: string;
  timestamp: string;
  detail?: string;
  artifactPath?: string;
  badge?: string;
  phaseId?: string;
}

export interface TeachingProcessingStep {
  id: string;
  label: string;
  description: string;
  state: TeachingProcessingStepState;
}

export interface TeachingProcessingOverview {
  taskType?: string;
  totalItems: number;
  actionItems: number;
  noteItems: number;
  artifactCount: number;
}

export interface TeachingReviewCard {
  id: string;
  title: string;
  goal: string;
  keyActions: string[];
  evidence: string;
}

export interface TeachingDraftSnapshot {
  title: string;
  summary: string;
}

export interface TeachingSavedAssetSummary {
  id: string;
  title: string;
  createdAt: string;
  cardCount: number;
  status: string;
  visibility: string;
  sourceTitle?: string;
  sourceUrl?: string;
  sourceDomain?: string;
}

export interface TeachingSavedAssetDetail extends TeachingSavedAssetSummary {
  teachingSessionId?: string;
  sourceDraftId?: string;
  cards: TeachingReviewCard[];
}
