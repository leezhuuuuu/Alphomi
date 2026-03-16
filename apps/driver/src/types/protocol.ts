/**
 * 元素定位配方 (复刻官方逻辑)
 * 官方不仅仅使用 ref ID，而是保存了如何重新找到该元素的方法
 */
export interface LocatorRecipe {
  role?: string;
  name?: string;
  matchIndex?: number;
  title?: string;
  text?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
  // 兜底策略
  selector?: string;
}

export interface NormalizedBBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface VisualCandidate {
  candidateId: number;
  bbox: NormalizedBBox;
  visibleText?: string;
  elementRole?: string;
  visualStyle: string;
  anchorText: string[];
  spatialContext: string;
  visualState?: string;
  confidence?: number;
}

export interface VisualInspectionPageState {
  url: string;
  widthCssPx: number;
  heightCssPx: number;
  scrollX: number;
  scrollY: number;
  tabId: number | null;
}

export interface StoredVisualInspection {
  inspectionId: string;
  createdAt: number;
  targetName: string;
  contextHint?: string;
  includeState: boolean;
  screenshotSha1: string;
  pageState: VisualInspectionPageState;
  candidates: VisualCandidate[];
}

export interface ScopeHintResolvedTarget {
  descriptor: string;
  name?: string;
  role?: string;
  valuePreview?: string;
}

export interface ScopeHintCandidate {
  descriptor: string;
  name?: string;
  role?: string;
  relation?: 'same_scope_submit' | 'nearby_confuser';
  recommended?: boolean;
  warning?: string;
}

export interface ScopeHint {
  scopeId?: string;
  scopeKind?: string;
  scopeDescriptor?: string;
  inputDescriptor?: string;
  submitCandidates?: string[];
  contextAnchors?: string[];
  resolvedTarget?: ScopeHintResolvedTarget;
  nextActionHints?: ScopeHintCandidate[];
  nearbyConfusers?: ScopeHintCandidate[];
}

/**
 * 工具执行结果
 * 必须包含 text (result), snapshot (binary/string), code (调试用)
 */
export interface ToolExecutionResult {
  // 操作的文本结果 (例如 "Clicked button")
  result?: string;
  // 页面快照 (YAML 字符串)
  snapshot?: string;
  // 截图 (Base64 字符串，用于 browser_take_screenshot)
  base64?: string;
  // 错误信息
  error?: string;
  // 生成的 Playwright 代码
  code?: string;
  // 输入/表单操作的局部作用域提示
  scopeHint?: ScopeHint;
  scopeHints?: ScopeHint[];
}

/**
 * REST API 通用响应
 */
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * 创建会话的配置
 */
export interface CreateSessionConfig {
  browser?: 'chromium' | 'firefox' | 'webkit';
  headless?: boolean;
  // 可扩展其他 Playwright LaunchOptions
}

/**
 * 会话信息
 */
export interface SessionInfo {
  id: string;
  createdAt: string;
  status: 'active' | 'closed';
}
