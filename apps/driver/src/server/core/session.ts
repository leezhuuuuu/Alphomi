import { Browser, BrowserContext, BrowserContextOptions, ConsoleMessage, Dialog, Frame, Locator, Page, Request, chromium } from 'playwright';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Snapshotter } from './snapshotter';
import {
  LocatorRecipe,
  ScopeHintCandidate,
  ScopeHintResolvedTarget,
  StoredVisualInspection,
  VisualInspectionPageState,
} from '../../types/protocol';

const TAB_ID_WINDOW_PROPERTY = '__AI_BROWSER_TAB_ID';
const getDesktopControlUrl = () =>
  process.env.DESKTOP_CONTROL_URL ||
  `http://127.0.0.1:${process.env.DESKTOP_CONTROL_PORT || '13001'}`;

type StorageStateScope = 'visited-origins' | 'active-only';
type StorageStateMergePolicy = 'merge' | 'overwrite' | 'replace_origin';
type LocalStorageMap = Record<string, Record<string, string>>;

type StorageStatePayload = {
  cookies: any[];
  localStorage: LocalStorageMap;
  visitedOrigins: string[];
  activeOrigin: string | null;
};

type SessionKind = 'MAIN' | 'SUB';

type SessionInitOptions = {
  headless?: boolean;
  recordHarPath?: string;
  recordHarContent?: 'embed' | 'attach' | 'omit';
  extraHTTPHeaders?: Record<string, string>;
  storageState?: BrowserContextOptions['storageState'];
};

const DEFAULT_MAX_VISITED_ORIGINS = (() => {
  const raw =
    process.env.USER_DATA_MAX_ORIGINS ||
    process.env.VISITED_ORIGINS_LIMIT ||
    process.env.MAX_ORIGINS ||
    process.env.max_origins;
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  return 200;
})();

const parsePositiveInt = (value: string | undefined, fallback: number, min: number = 1): number => {
  const parsed = value ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.floor(parsed);
  if (normalized < min) return fallback;
  return normalized;
};

const parseRatio = (value: string | undefined, fallback: number): number => {
  const parsed = value ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) return fallback;
  return parsed;
};

const SNAPSHOT_WAIT_FOR_READY = process.env.SNAPSHOT_WAIT_FOR_READY !== 'false';
const SNAPSHOT_READY_TIMEOUT_MS = parsePositiveInt(process.env.SNAPSHOT_READY_TIMEOUT_MS, 12000);
const SNAPSHOT_DOMCONTENT_TIMEOUT_MS = parsePositiveInt(process.env.SNAPSHOT_DOMCONTENT_TIMEOUT_MS, 4000);
const SNAPSHOT_LOADING_TIMEOUT_MS = parsePositiveInt(process.env.SNAPSHOT_LOADING_TIMEOUT_MS, 3500);
const SNAPSHOT_DOM_QUIET_TIMEOUT_MS = parsePositiveInt(process.env.SNAPSHOT_DOM_QUIET_TIMEOUT_MS, 6000);
const SNAPSHOT_DOM_QUIET_WINDOW_MS = parsePositiveInt(process.env.SNAPSHOT_DOM_QUIET_WINDOW_MS, 800, 50);
const SNAPSHOT_DOM_POLL_MS = parsePositiveInt(process.env.SNAPSHOT_DOM_POLL_MS, 100, 25);
const SNAPSHOT_DIFF_ENABLED = process.env.SNAPSHOT_DIFF_ENABLED !== 'false';
const SNAPSHOT_DIFF_FORCE_FULL_EVERY = parsePositiveInt(process.env.SNAPSHOT_DIFF_FORCE_FULL_EVERY, 6);
const SNAPSHOT_DIFF_MAX_LINES = parsePositiveInt(process.env.SNAPSHOT_DIFF_MAX_LINES, 80);
const SNAPSHOT_DIFF_CHANGE_RATIO_THRESHOLD = parseRatio(process.env.SNAPSHOT_DIFF_CHANGE_RATIO_THRESHOLD, 0.35);
const SNAPSHOT_DIFF_MIN_FULL_LINES = parsePositiveInt(process.env.SNAPSHOT_DIFF_MIN_FULL_LINES, 24);
const SNAPSHOT_DIFF_MIN_REDUCTION_RATIO = parseRatio(process.env.SNAPSHOT_DIFF_MIN_REDUCTION_RATIO, 0.2);
const SNAPSHOT_DIFF_LCS_CELL_LIMIT = parsePositiveInt(process.env.SNAPSHOT_DIFF_LCS_CELL_LIMIT, 350000);
const VISUAL_INSPECTION_CACHE_SIZE = parsePositiveInt(process.env.VISUAL_INSPECTION_CACHE_SIZE, 20);
const SNAPSHOT_LOADING_SELECTORS = (
  process.env.SNAPSHOT_LOADING_SELECTORS ||
  '[aria-busy="true"],[data-loading="true"],.loading,.spinner,.skeleton,.ant-spin-spinning'
)
  .split(',')
  .map((item) => item.trim())
  .filter((item) => item.length > 0);
const ACTION_SCOPE_ATTR = 'data-alphomi-scope-id';

type SnapshotDiffResult = {
  added: string[];
  removed: string[];
  addedCount: number;
  removedCount: number;
  changeRatio: number;
};

type CaptureSnapshotOptions = {
  forceFullSnapshot?: boolean;
};

type ScopedActionContext = {
  scopeId: string;
  pageUrl: string;
  inputDescriptor: string;
  scopeKind?: string;
  scopeDescriptor?: string;
  submitCandidates: string[];
  contextAnchors?: string[];
  resolvedTarget?: ScopeHintResolvedTarget;
  nextActionHints?: ScopeHintCandidate[];
  nearbyConfusers?: ScopeHintCandidate[];
  updatedAt: number;
};

export class BrowserSession {
  public readonly id: string;
  public readonly createdAt: Date;
  public readonly kind: SessionKind;
  
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  
  // 区分是自己启动的还是连接的，这决定了 close 时的行为
  private isAttached: boolean = false;
  
  // 每个 Session 拥有一个 Snapshotter，负责维护当前的 ref 状态
  private snapshotter: Snapshotter | null = null;
  
  // 控制台日志缓存
  private consoleLogs: string[] = [];
  
  // 增加一个临时存储下一个 Dialog 处理方式的变量
  private nextDialogAction: { accept: boolean, promptText?: string } | null = null;
  
  // 网络请求日志
  private networkLogs: string[] = [];
  
  private pageTabIdCache: WeakMap<Page, number> = new WeakMap();
  private lastDesktopTabId: number | null = null;

  private visitedOrigins: Map<string, number> = new Map();
  private activeOrigin: string | null = null;
  private maxVisitedOrigins: number;
  private trackedPages: WeakSet<Page> = new WeakSet();
  private internalPages: WeakSet<Page> = new WeakSet();
  private contextListenersBound = false;
  private localStorageCache: Map<string, Record<string, string>> = new Map();
  private pendingLocalStorage: Map<string, { entries: Record<string, string>; policy: StorageStateMergePolicy }> = new Map();
  private snapshotVersion = 0;
  private snapshotSinceLastFull = 0;
  private lastSnapshotUrl: string | null = null;
  private lastSnapshotHash: string | null = null;
  private lastSnapshotRawLines: string[] = [];
  private lastSnapshotNormalizedLines: string[] = [];
  private lastKnownRefRecipes: Map<string, LocatorRecipe> = new Map();
  private scopedActionContext: ScopedActionContext | null = null;
  private visualInspections: Map<string, StoredVisualInspection> = new Map();

  private onConsole = (msg: ConsoleMessage) => {
    const text = `[${msg.type()}] ${msg.text()}`;
    this.consoleLogs.push(text);
    // 限制日志大小，保留最近 100 条
    if (this.consoleLogs.length > 100) this.consoleLogs.shift();
  };

  private onDialog = async (dialog: Dialog) => {
    console.log(`[BrowserSession] Dialog appeared: ${dialog.type()} - ${dialog.message()}`);

    if (this.nextDialogAction) {
      if (this.nextDialogAction.accept) {
        await dialog.accept(this.nextDialogAction.promptText);
      } else {
        await dialog.dismiss();
      }
      // 用完即焚，或者保持？官方没有明确说明，通常是一次性的
      this.nextDialogAction = null;
    } else {
      // 默认行为：为了不阻塞脚本，通常默认关闭
      await dialog.dismiss();
    }
  };

  private onRequest = (request: Request) => {
    this.networkLogs.push(`[${request.method()}] ${request.url()}`);
    if (this.networkLogs.length > 200) this.networkLogs.shift();
  };

  private onFrameNavigated = (frame: Frame) => {
    if (frame.parentFrame()) return;
    const page = frame.page();
    if (this.internalPages.has(page)) return;
    this.recordVisitedOrigin(frame.url());
    const origin = this.extractHttpOrigin(frame.url());
    if (origin) {
      void this.applyPendingLocalStorageToPage(origin, page);
    }
  };

  private onContextPage = (page: Page) => {
    this.trackPage(page);
  };

  // Helper: 判定是否为 Electron 自身的 UI 页面（需排除）
  private isUiPage(url: string): boolean {
    if (!url) return false;

    // 明确排除：开发者工具/打包资源
    if (url.startsWith('devtools://') || url.startsWith('file://') || url.includes('app://')) {
      return true;
    }

    // 如果 Electron 提供了渲染器地址，直接比对前缀
    const rendererUrl = process.env.ELECTRON_RENDERER_URL;
    if (rendererUrl && url.startsWith(rendererUrl)) {
      return true;
    }

    // Vite dev server 默认 5173，若端口占用会递增到 5174/5175...
    const match = url.match(/^https?:\/\/localhost:(\d+)/);
    if (match) {
      const port = Number(match[1]);
      if (port >= 5170 && port < 5180) {
        return true;
      }
    }

    return false;
  }

  private setupContextTracking() {
    if (!this.context || this.contextListenersBound) return;
    this.contextListenersBound = true;
    this.context.on('page', this.onContextPage);
    for (const page of this.context.pages()) {
      this.trackPage(page);
    }
  }

  private trackPage(page: Page) {
    if (this.trackedPages.has(page)) return;
    this.trackedPages.add(page);
    page.on('framenavigated', this.onFrameNavigated);
    this.recordVisitedOrigin(page.url());
  }

  private findExistingPageForOrigin(origin: string): Page | null {
    if (!this.context) return null;
    const pages = this.context.pages();
    let fallback: Page | null = null;

    for (const page of pages) {
      if (page.isClosed()) continue;
      if (this.internalPages.has(page)) continue;
      const pageOrigin = this.extractHttpOrigin(page.url());
      if (!pageOrigin) continue;
      if (pageOrigin === origin) {
        if (page === this.page) return page;
        if (!fallback) fallback = page;
      }
    }

    return fallback;
  }

  private mergeLocalStorageCache(
    origin: string,
    entries: Record<string, string>,
    policy: StorageStateMergePolicy
  ) {
    if (policy === 'replace_origin') {
      this.localStorageCache.set(origin, { ...entries });
      return;
    }
    const current = this.localStorageCache.get(origin) || {};
    this.localStorageCache.set(origin, { ...current, ...entries });
  }

  private async readLocalStorageFromPage(page: Page): Promise<Record<string, string>> {
    const entries = await page.evaluate(() => {
      const data: Record<string, string> = {};
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key !== null) {
          const value = localStorage.getItem(key);
          if (value !== null) {
            data[key] = value;
          }
        }
      }
      return data;
    });
    return entries || {};
  }

  private async writeLocalStorageToPage(
    page: Page,
    entries: Record<string, string>,
    mergePolicy: StorageStateMergePolicy
  ) {
    await page.evaluate(
      ({ items, policy }) => {
        if (policy === 'replace_origin') {
          localStorage.clear();
        }
        for (const [key, value] of Object.entries(items)) {
          localStorage.setItem(key, String(value));
        }
      },
      { items: entries, policy: mergePolicy }
    );
  }

  private async applyPendingLocalStorageToPage(origin: string, page: Page): Promise<boolean> {
    const pending = this.pendingLocalStorage.get(origin);
    if (!pending) return false;
    try {
      await this.writeLocalStorageToPage(page, pending.entries, pending.policy);
      this.mergeLocalStorageCache(origin, pending.entries, pending.policy);
      this.pendingLocalStorage.delete(origin);
      return true;
    } catch (e) {
      console.warn(`[BrowserSession] Failed to apply pending localStorage for ${origin}: ${String(e)}`);
      return false;
    }
  }

  private buildLocalStorageSnapshot(): LocalStorageMap {
    const snapshot: LocalStorageMap = {};
    for (const [origin, entries] of this.localStorageCache.entries()) {
      snapshot[origin] = { ...entries };
    }
    return snapshot;
  }

  private async installLocalStorageInitScript(entries: LocalStorageMap) {
    if (!this.context) return;
    try {
      const content = `
        (() => {
          try {
            const data = ${JSON.stringify(entries)};
            const origin = location && location.origin;
            if (!origin || !data[origin]) return;
            const items = data[origin];
            for (const [key, value] of Object.entries(items)) {
              if (localStorage.getItem(key) !== String(value)) {
                localStorage.setItem(key, String(value));
              }
            }
          } catch (e) {
            // ignore init script errors
          }
        })();
      `;
      await this.context.addInitScript({ content });
    } catch (e) {
      console.warn('[BrowserSession] Failed to install localStorage init script:', e);
    }
  }

  private extractHttpOrigin(url: string): string | null {
    if (!url) return null;
    if (this.isUiPage(url)) return null;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.origin;
  }

  private touchVisitedOrigin(origin: string) {
    if (this.visitedOrigins.has(origin)) {
      this.visitedOrigins.delete(origin);
    }
    this.visitedOrigins.set(origin, Date.now());
    if (this.visitedOrigins.size > this.maxVisitedOrigins) {
      const oldest = this.visitedOrigins.keys().next().value as string | undefined;
      if (oldest) this.visitedOrigins.delete(oldest);
    }
  }

  private recordVisitedOrigin(url: string) {
    const origin = this.extractHttpOrigin(url);
    if (!origin) return;
    this.activeOrigin = origin;
    this.touchVisitedOrigin(origin);
  }

  constructor(kind: SessionKind = 'SUB', maxVisitedOrigins: number = DEFAULT_MAX_VISITED_ORIGINS) {
    this.id = uuidv4();
    this.createdAt = new Date();
    this.kind = kind;
    this.maxVisitedOrigins = maxVisitedOrigins;
  }

  async init(options: SessionInitOptions = {}) {
    this.isAttached = false;
    const {
      headless = true,
      recordHarPath,
      recordHarContent = 'embed',
      extraHTTPHeaders,
      storageState,
    } = options;

    // 1:1 复刻：官方默认启用了一些权限和 viewport 设置
    this.browser = await chromium.launch({
      headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox'] // 容器化友好
    });

    if (recordHarPath) {
      fs.mkdirSync(path.dirname(recordHarPath), { recursive: true });
    }

    const recordHar = recordHarPath
      ? {
          path: recordHarPath,
          content: recordHarContent,
        }
      : undefined;

    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 }, // 标准分辨率
      locale: 'en-US', // 保持一致性
      ...(recordHar ? { recordHar } : {}),
      ...(extraHTTPHeaders ? { extraHTTPHeaders } : {}),
      ...(storageState ? { storageState } : {}),
    });
    
    this.page = await this.context.newPage();
    this.setupContextTracking();
    this._setupListeners(this.page); // 绑定监听
    this.snapshotter = new Snapshotter(this.page);
  }

  // 模式 2: CDP 连接模式 (增强版)
  async attach(cdpEndpoint: string) {
    this.isAttached = true;
    let wsEndpoint = cdpEndpoint;

    // 自动探测：如果给的是 HTTP，尝试获取 WS 地址
    if (cdpEndpoint.startsWith('http')) {
      try {
        console.log(`[BrowserSession] Fetching WS URL from ${cdpEndpoint}/json/version...`);
        // 注意：这里要处理结尾的斜杠
        const url = cdpEndpoint.replace(/\/$/, '') + '/json/version';
        const response = await axios.get(url);
        if (response.data && response.data.webSocketDebuggerUrl) {
          wsEndpoint = response.data.webSocketDebuggerUrl;
          console.log(`[BrowserSession] Resolved WS Endpoint: ${wsEndpoint}`);
        } else {
          throw new Error('Invalid response from CDP endpoint');
        }
      } catch (e: any) {
        console.error(`[BrowserSession] Failed to fetch CDP info: ${e.message}`);
        // 如果失败了，我们还是尝试把原始地址传给 Playwright，死马当活马医
      }
    }

    console.log(`[BrowserSession] Connecting to Playwright with: ${wsEndpoint}`);
    
    try {
      // 连接到现有的浏览器实例
      this.browser = await chromium.connectOverCDP(wsEndpoint);
      
      // 获取所有上下文
      const contexts = this.browser.contexts();
      if (contexts.length === 0) {
        // 如果连接的是 Electron，通常已经有一个 default context
        // 如果是纯 Chrome，可能需要 newContext
        this.context = await this.browser.newContext();
      } else {
        this.context = contexts[0];
      }
      
      // 获取所有页面
      const pages = this.context.pages();
      
      // 打印所有页面供调试
      pages.forEach((p, i) => console.log(`[Page ${i}] ${p.url()}`));

      const tabIdPage = await this.findPageWithTabId(pages);
      if (tabIdPage) {
        this.page = tabIdPage;
        const cachedTabId = this.getCachedTabId(tabIdPage);
        if (typeof cachedTabId === 'number') {
          this.lastDesktopTabId = cachedTabId;
        }
        console.log(`[BrowserSession] Selected tab page: ${this.page.url()}`);
      } else {
        // 优先查找带有 BrowserView 标记的页面
        const browserViewPage = pages.find(p => p.url().includes('about:blank#browser-view'));
        if (browserViewPage) {
          this.page = browserViewPage;
          console.log(`[BrowserSession] Selected BrowserView page: ${this.page.url()}`);
        } else {
          // 过滤掉 UI 页面 (Electron Renderer)
          // UI 页面通常运行在 localhost:5173 (dev) 或 file:// (prod)
          const validPages = pages.filter(p => !this.isUiPage(p.url()));

          if (validPages.length > 0) {
            // 优先接管非 UI 页面
            this.page = validPages[0];
            console.log(`[BrowserSession] Selected target page: ${this.page.url()}`);
          } else if (pages.length > 0) {
            // 如果实在没别的，尝试找到 about:blank 页面（BrowserView 初始页面）
            const blankPage = pages.find(p => p.url() === 'about:blank');
            if (blankPage) {
              this.page = blankPage;
              console.log(`[BrowserSession] Selected about:blank page: ${this.page.url()}`);
            } else {
              // 兜底：使用第一个页面，但记录警告
              this.page = pages[0];
              console.warn(`[BrowserSession] No valid content page found, using pages[0]: ${this.page.url()}`);
            }
          } else {
            // 如果没有任何页面，新建一个
            this.page = await this.context.newPage();
            console.log(`[BrowserSession] Created new page: ${this.page.url()}`);
          }
        }
      }

      console.log(`[BrowserSession] Attached to page: ${this.page.url()}`);
      this.setupContextTracking();
      this._setupListeners(this.page); // 绑定监听
      this.snapshotter = new Snapshotter(this.page);

    } catch (error) {
      console.error('[BrowserSession] Attach failed:', error);
      throw error;
    }
  }

  async close() {
    if (this.isAttached) {
      // 如果是连接模式，我们不关闭浏览器，只断开连接
      console.log('[BrowserSession] Detaching from CDP...');
      await this.browser?.close(); // 在 connectOverCDP 模式下，close() 实际上是断开连接
    } else {
      // 自启动模式，彻底关闭
      await this.context?.close();
      await this.browser?.close();
    }
    this.snapshotter = null;
  }

  isAttachedSession(): boolean {
    return this.isAttached;
  }

  getPage(): Page {
    if (!this.page || this.page.isClosed()) {
      // 尝试重新获取页面（针对 Tab 可能被用户关闭的情况）
      const pages = this.context?.pages() || [];
      
      if (typeof this.lastDesktopTabId === 'number') {
        const cachedMatch = this.findPageByCachedTabId(pages, this.lastDesktopTabId);
        if (cachedMatch) {
          this.page = cachedMatch;
          this.snapshotter = new Snapshotter(this.page);
          console.log(`[BrowserSession] Re-selected cached tab page: ${this.page.url()}`);
          return this.page;
        }
      }

      const anyCached = this.findAnyPageWithCachedTabId(pages);
      if (anyCached) {
        this.page = anyCached;
        this.snapshotter = new Snapshotter(this.page);
        console.log(`[BrowserSession] Re-selected cached page: ${this.page.url()}`);
        return this.page;
      }

      // 优先查找带有 BrowserView 标记的页面
      const browserViewPage = pages.find(p => p.url().includes('about:blank#browser-view'));
      if (browserViewPage) {
        this.page = browserViewPage;
        this.snapshotter = new Snapshotter(this.page);
        console.log(`[BrowserSession] Re-selected BrowserView page: ${this.page.url()}`);
        return this.page;
      }
      
      // 过滤掉 UI 页面
      const validPages = pages.filter(p => !this.isUiPage(p.url()));
      
      if (validPages.length > 0) {
        this.page = validPages[0];
        this.snapshotter = new Snapshotter(this.page);
        console.log(`[BrowserSession] Re-selected valid page: ${this.page.url()}`);
        return this.page;
      }
      
      if (pages.length > 0) {
        this.page = pages[pages.length - 1]; // 取最新的 Tab
        this.snapshotter = new Snapshotter(this.page);
        console.log(`[BrowserSession] Re-selected latest page: ${this.page.url()}`);
        return this.page;
      }
      
      throw new Error('Page is closed or not initialized');
    }
    return this.page;
  }

  // --- 核心操作 ---

  /**
   * 生成快照并更新 Ref 映射
   */
  async captureSnapshot(full: boolean = false, options: CaptureSnapshotOptions = {}): Promise<string> {
    if (!this.snapshotter) throw new Error('Snapshotter not initialized');
    const forceFullSnapshot = options.forceFullSnapshot === true;
    const effectiveFull = full || forceFullSnapshot;

    let readiness: { ready: boolean; notes: string[] } = { ready: true, notes: [] };
    try {
      readiness = await this.waitForSnapshotReadiness();
    } catch (error) {
      readiness = {
        ready: false,
        notes: [`readiness-check:${this.asErrorMessage(error)}`],
      };
    }

    const rawSnapshot = await this.snapshotter.capture(effectiveFull);
    this.lastKnownRefRecipes = new Map(this.snapshotter.refs);
    const output = this.renderSnapshotOutput(rawSnapshot, forceFullSnapshot);
    if (readiness.ready) {
      return output;
    }

    const note = readiness.notes.length > 0 ? readiness.notes.slice(0, 3).join(' | ') : 'timeout';
    return `# Snapshot Notice: page may still be loading/updating (timeout guard triggered: ${note})\n${output}`;
  }

  private asErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private getSnapshotRemainingBudget(totalBudgetMs: number, startedAt: number): number {
    return Math.max(0, totalBudgetMs - (Date.now() - startedAt));
  }

  private getSnapshotStepTimeout(totalBudgetMs: number, startedAt: number, preferredTimeoutMs: number): number {
    const remaining = this.getSnapshotRemainingBudget(totalBudgetMs, startedAt);
    if (remaining <= 0) return 0;
    return Math.max(1, Math.min(remaining, preferredTimeoutMs));
  }

  private async waitForSnapshotReadiness(): Promise<{ ready: boolean; notes: string[] }> {
    if (!SNAPSHOT_WAIT_FOR_READY) {
      return { ready: true, notes: [] };
    }

    const page = this.getPage();
    const notes: string[] = [];
    const startedAt = Date.now();
    let ready = true;

    const runStep = async (
      label: string,
      preferredTimeoutMs: number,
      task: (timeoutMs: number) => Promise<void>,
      timeoutMeansNotReady: boolean
    ) => {
      const timeoutMs = this.getSnapshotStepTimeout(SNAPSHOT_READY_TIMEOUT_MS, startedAt, preferredTimeoutMs);
      if (timeoutMs <= 0) {
        notes.push(`${label}:budget_exhausted`);
        if (timeoutMeansNotReady) ready = false;
        return;
      }
      try {
        await task(timeoutMs);
      } catch (error) {
        notes.push(`${label}:${this.asErrorMessage(error)}`);
        if (timeoutMeansNotReady) ready = false;
      }
    };

    await runStep(
      'domcontentloaded',
      SNAPSHOT_DOMCONTENT_TIMEOUT_MS,
      async (timeoutMs) => page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }),
      true
    );

    if (ready) {
      await runStep(
        'loading-hidden',
        SNAPSHOT_LOADING_TIMEOUT_MS,
        async (timeoutMs) => this.waitForLoadingIndicatorsToDisappear(timeoutMs),
        false
      );

      await runStep(
        'dom-quiet',
        SNAPSHOT_DOM_QUIET_TIMEOUT_MS,
        async (timeoutMs) => this.waitForDomQuietWindow(timeoutMs),
        true
      );
    }

    if (this.getSnapshotRemainingBudget(SNAPSHOT_READY_TIMEOUT_MS, startedAt) <= 0) {
      ready = false;
      notes.push('overall:timeout');
    }

    return { ready, notes };
  }

  private async waitForLoadingIndicatorsToDisappear(timeoutMs: number): Promise<void> {
    if (SNAPSHOT_LOADING_SELECTORS.length === 0) return;
    const page = this.getPage();
    await page.waitForFunction(
      (selectors: string[]) => {
        const isVisible = (node: Element): boolean => {
          if (!(node instanceof HTMLElement)) return true;
          if (node.hidden) return false;
          if (node.getAttribute('aria-hidden') === 'true') return false;
          const style = window.getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };

        for (const selector of selectors) {
          let elements: Element[] = [];
          try {
            elements = Array.from(document.querySelectorAll(selector));
          } catch {
            continue;
          }
          if (elements.some(isVisible)) {
            return false;
          }
        }
        return true;
      },
      SNAPSHOT_LOADING_SELECTORS,
      { timeout: timeoutMs, polling: SNAPSHOT_DOM_POLL_MS }
    );
  }

  private async waitForDomQuietWindow(timeoutMs: number): Promise<void> {
    const page = this.getPage();

    await page.evaluate(() => {
      const key = '__pbSnapshotQuietState';
      const w = window as unknown as Record<string, any>;
      const state = w[key] as { lastMutationAt: number; observer?: MutationObserver } | undefined;
      if (!state) {
        const nextState: { lastMutationAt: number; observer?: MutationObserver } = {
          lastMutationAt: Date.now(),
        };
        const root = document.documentElement || document.body;
        if (root) {
          const observer = new MutationObserver(() => {
            nextState.lastMutationAt = Date.now();
          });
          observer.observe(root, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
          });
          nextState.observer = observer;
        }
        document.addEventListener('readystatechange', () => {
          nextState.lastMutationAt = Date.now();
        });
        w[key] = nextState;
        return;
      }
      state.lastMutationAt = Date.now();
    });

    await page.waitForFunction(
      (quietWindowMs: number) => {
        const key = '__pbSnapshotQuietState';
        const w = window as unknown as Record<string, any>;
        const state = w[key] as { lastMutationAt?: number } | undefined;
        if (!state || typeof state.lastMutationAt !== 'number') return false;
        return Date.now() - state.lastMutationAt >= quietWindowMs;
      },
      SNAPSHOT_DOM_QUIET_WINDOW_MS,
      { timeout: timeoutMs, polling: SNAPSHOT_DOM_POLL_MS }
    );
  }

  private isDiffEligibleSnapshot(snapshot: string): boolean {
    if (!snapshot || snapshot === 'No content') return false;
    if (snapshot.startsWith('Error capturing snapshot:')) return false;
    return true;
  }

  private splitSnapshotLines(snapshot: string): string[] {
    if (!snapshot) return [];
    return snapshot
      .split('\n')
      .map((line) => line.replace(/\r$/, ''))
      .filter((line) => line.trim().length > 0);
  }

  private normalizeSnapshotLine(line: string): string {
    return line
      .replace(/\[ref=e\d+\]/g, '[ref=*]')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private hashSnapshotLines(lines: string[]): string {
    const normalized = lines.join('\n');
    return createHash('sha1').update(normalized).digest('hex');
  }

  private buildSnapshotDiff(
    prevNormalized: string[],
    prevRaw: string[],
    currNormalized: string[],
    currRaw: string[]
  ): SnapshotDiffResult {
    const n = prevNormalized.length;
    const m = currNormalized.length;
    if (n * m > SNAPSHOT_DIFF_LCS_CELL_LIMIT) {
      return {
        added: [],
        removed: [],
        addedCount: currRaw.length,
        removedCount: prevRaw.length,
        changeRatio: 1,
      };
    }

    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        if (prevNormalized[i] === currNormalized[j]) {
          dp[i][j] = dp[i + 1][j + 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
    }

    const added: string[] = [];
    const removed: string[] = [];
    let i = 0;
    let j = 0;

    while (i < n && j < m) {
      if (prevNormalized[i] === currNormalized[j]) {
        i += 1;
        j += 1;
        continue;
      }
      if (dp[i + 1][j] >= dp[i][j + 1]) {
        removed.push(prevRaw[i]);
        i += 1;
      } else {
        added.push(currRaw[j]);
        j += 1;
      }
    }
    while (i < n) {
      removed.push(prevRaw[i]);
      i += 1;
    }
    while (j < m) {
      added.push(currRaw[j]);
      j += 1;
    }

    const changeCount = added.length + removed.length;
    const changeRatio = changeCount / Math.max(m, 1);

    return {
      added,
      removed,
      addedCount: added.length,
      removedCount: removed.length,
      changeRatio,
    };
  }

  private formatSnapshotDelta(version: number, baseVersion: number, hash: string, diff: SnapshotDiffResult): string {
    const lines: string[] = [];
    const previewAdded = diff.added.slice(0, SNAPSHOT_DIFF_MAX_LINES);
    const previewRemoved = diff.removed.slice(0, SNAPSHOT_DIFF_MAX_LINES);

    lines.push(`# Snapshot Delta v${version} (base v${baseVersion})`);
    lines.push(`# hash=${hash.slice(0, 12)} changes=+${diff.addedCount} -${diff.removedCount} ratio=${(diff.changeRatio * 100).toFixed(1)}%`);

    if (previewAdded.length > 0) {
      lines.push('# Added/Updated');
      for (const line of previewAdded) {
        lines.push(`+ ${line}`);
      }
      if (diff.addedCount > previewAdded.length) {
        lines.push(`+ ... (${diff.addedCount - previewAdded.length} more added lines hidden)`);
      }
    }

    if (previewRemoved.length > 0) {
      lines.push('# Removed');
      for (const line of previewRemoved) {
        lines.push(`- ${line}`);
      }
      if (diff.removedCount > previewRemoved.length) {
        lines.push(`- ... (${diff.removedCount - previewRemoved.length} more removed lines hidden)`);
      }
    }

    return lines.join('\n');
  }

  private formatSnapshotUnchanged(version: number, baseVersion: number, hash: string): string {
    return `# Snapshot Unchanged v${version} (base v${baseVersion}) hash=${hash.slice(0, 12)}`;
  }

  private renderSnapshotOutput(rawSnapshot: string, forceFullSnapshot: boolean): string {
    const currentUrl = this.getPage().url();
    this.snapshotVersion += 1;
    const version = this.snapshotVersion;
    const baseVersion = version > 1 ? version - 1 : 0;

    if (!this.isDiffEligibleSnapshot(rawSnapshot)) {
      this.lastSnapshotUrl = currentUrl;
      this.lastSnapshotHash = null;
      this.lastSnapshotRawLines = [];
      this.lastSnapshotNormalizedLines = [];
      this.snapshotSinceLastFull = 0;
      return rawSnapshot;
    }

    const rawLines = this.splitSnapshotLines(rawSnapshot);
    const normalizedLines = rawLines.map((line) => this.normalizeSnapshotLine(line));
    const currentHash = this.hashSnapshotLines(normalizedLines);

    const firstSnapshot = this.lastSnapshotHash === null;
    const urlChanged = this.lastSnapshotUrl !== null && this.lastSnapshotUrl !== currentUrl;
    const lowLineCount = rawLines.length < SNAPSHOT_DIFF_MIN_FULL_LINES;
    const forcePeriodicFull = this.snapshotSinceLastFull >= SNAPSHOT_DIFF_FORCE_FULL_EVERY;

    let output = rawSnapshot;
    let mode: 'full' | 'delta' | 'unchanged' = 'full';

    const canTryDiff =
      SNAPSHOT_DIFF_ENABLED &&
      !forceFullSnapshot &&
      !firstSnapshot &&
      !urlChanged &&
      !forcePeriodicFull &&
      !lowLineCount;

    if (canTryDiff) {
      if (currentHash === this.lastSnapshotHash) {
        mode = 'unchanged';
        output = this.formatSnapshotUnchanged(version, baseVersion, currentHash);
      } else {
        const diff = this.buildSnapshotDiff(
          this.lastSnapshotNormalizedLines,
          this.lastSnapshotRawLines,
          normalizedLines,
          rawLines
        );

        const deltaText = this.formatSnapshotDelta(version, baseVersion, currentHash, diff);
        const reductionRatio = 1 - deltaText.length / Math.max(rawSnapshot.length, 1);

        const deltaIsWorthUsing =
          diff.changeRatio <= SNAPSHOT_DIFF_CHANGE_RATIO_THRESHOLD &&
          diff.addedCount + diff.removedCount > 0 &&
          reductionRatio >= SNAPSHOT_DIFF_MIN_REDUCTION_RATIO;

        if (deltaIsWorthUsing) {
          mode = 'delta';
          output = deltaText;
        }
      }
    }

    if (mode === 'full') {
      this.snapshotSinceLastFull = 0;
    } else {
      this.snapshotSinceLastFull += 1;
    }

    this.lastSnapshotUrl = currentUrl;
    this.lastSnapshotHash = currentHash;
    this.lastSnapshotRawLines = rawLines;
    this.lastSnapshotNormalizedLines = normalizedLines;

    return output;
  }

  /**
   * 深度复刻官方的定位逻辑 + 增强容错
   */
  async getLocator(refId: string): Promise<Locator> {
    if (!this.snapshotter) throw new Error('Snapshotter not initialized');

    let recipe = this.snapshotter.refs.get(refId);
    if (!recipe) {
      const lastKnownRecipe = this.lastKnownRefRecipes.get(refId);
      if (!lastKnownRecipe) {
        throw new Error(`Ref '${refId}' not found. Please take a new snapshot.`);
      }

      try {
        await this.captureSnapshot(true, { forceFullSnapshot: true });
      } catch (error) {
        console.warn(`[BrowserSession] Failed to refresh snapshot during locator recovery for ref=${refId}: ${this.asErrorMessage(error)}`);
      }

      const recoveredLocator = await this.resolveLocatorByRecipe(lastKnownRecipe);
      if (recoveredLocator) {
        console.warn(`[BrowserSession] Recovered stale ref '${refId}' using last known locator recipe.`);
        return recoveredLocator;
      }

      throw new Error(`Ref '${refId}' not found after recovery attempt. Please take a new snapshot.`);
    }

    const locator = await this.resolveLocatorByRecipe(recipe);
    if (locator) {
      return locator;
    }

    throw new Error(`Cannot locate element '${refId}'`);
  }

  getLocatorRecipe(refId: string): LocatorRecipe | undefined {
    if (!this.snapshotter) throw new Error('Snapshotter not initialized');
    return this.snapshotter.refs.get(refId) || this.lastKnownRefRecipes.get(refId);
  }

  getScopedActionContext(): ScopedActionContext | null {
    if (!this.scopedActionContext) {
      return null;
    }

    return {
      ...this.scopedActionContext,
      submitCandidates: [...this.scopedActionContext.submitCandidates],
      contextAnchors: this.scopedActionContext.contextAnchors
        ? [...this.scopedActionContext.contextAnchors]
        : undefined,
      resolvedTarget: this.scopedActionContext.resolvedTarget
        ? { ...this.scopedActionContext.resolvedTarget }
        : undefined,
      nextActionHints: this.scopedActionContext.nextActionHints
        ? this.scopedActionContext.nextActionHints.map((candidate) => ({ ...candidate }))
        : undefined,
      nearbyConfusers: this.scopedActionContext.nearbyConfusers
        ? this.scopedActionContext.nearbyConfusers.map((candidate) => ({ ...candidate }))
        : undefined,
    };
  }

  async clearScopedActionContext() {
    const page = this.page;
    this.scopedActionContext = null;
    if (!page || page.isClosed()) {
      return;
    }

    try {
      await page.evaluate((scopeAttr) => {
        document.querySelectorAll(`[${scopeAttr}]`).forEach((node) => {
          node.removeAttribute(scopeAttr);
        });
      }, ACTION_SCOPE_ATTR);
    } catch (error) {
      console.warn(`[BrowserSession] Failed to clear scoped action context: ${this.asErrorMessage(error)}`);
    }
  }

  async rememberInputScope(locator: Locator): Promise<ScopedActionContext | null> {
    const page = this.getPage();
    const scopeId = `scope_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const scoped = await locator.evaluate(
      (node: Element, payload: { scopeAttr: string; scopeId: string; pageUrl: string }) => {
        const normalize = (value: string | null | undefined): string =>
          (value || '').replace(/\s+/g, ' ').trim();
        const editableSelector =
          'input:not([type="hidden"]), textarea, [contenteditable=""], [contenteditable="true"], [role="textbox"]';
        const buttonSelector =
          'button, input[type="submit"], input[type="button"], [role="button"], a[role="button"]';
        const submitNamePattern =
          /^(post|save|submit|confirm|apply|create|update|publish|send|done|ok|reply|comment|search|go|continue|next)$/i;

        const isVisible = (element: Element | null): element is HTMLElement => {
          if (!(element instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0
          );
        };

        const labelOf = (element: Element): string => {
          const html = element as HTMLElement;
          const input = element as HTMLInputElement;
          return normalize(
            html.getAttribute('aria-label') ||
              html.getAttribute('title') ||
              html.innerText ||
              html.textContent ||
              input.value ||
              ''
          );
        };

        const roleOf = (element: Element): string =>
          normalize(element.getAttribute('role') || element.tagName.toLowerCase());

        const describe = (element: Element): string => {
          const role = roleOf(element) || 'generic';
          const label = labelOf(element);
          return label ? `${role} "${label}"` : role;
        };

        const valueOf = (element: Element): string => {
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            return normalize(element.value);
          }
          const html = element as HTMLElement;
          if (html.isContentEditable) {
            return normalize(html.innerText || html.textContent || '');
          }
          return normalize(html.innerText || html.textContent || '');
        };

        const looksLikeSubmit = (element: Element): boolean => {
          const tag = element.tagName.toLowerCase();
          const type =
            element instanceof HTMLInputElement ? normalize(element.type).toLowerCase() : '';
          const label = labelOf(element);
          if (tag === 'button') return true;
          if (tag === 'input' && (type === 'submit' || type === 'button')) return true;
          if (roleOf(element) === 'button' && submitNamePattern.test(label)) return true;
          return submitNamePattern.test(label);
        };

        const shortVisibleText = (element: Element): string => {
          const text = labelOf(element);
          if (!text || text.length > 80) {
            return '';
          }
          return text;
        };

        const inferScopeKind = (element: HTMLElement, submitLabels: string[]): string => {
          const tag = element.tagName.toLowerCase();
          const role = roleOf(element);
          const normalizedLabels = submitLabels.map((label) => label.toLowerCase());

          if (tag === 'form' || role === 'form') return 'form';
          if (tag === 'dialog' || role === 'dialog') return 'dialog';
          if (normalizedLabels.some((label) => ['post', 'reply', 'comment'].includes(label))) return 'composer';
          if (role === 'group') return 'group';
          if (role === 'region') return 'region';
          return role || tag || 'container';
        };

        const collectContextAnchors = (
          scopeRoot: HTMLElement,
          editableElement: HTMLElement,
          excludedLabels: Set<string>,
          currentValue: string
        ): string[] => {
          const selectors = 'a, h1, h2, h3, h4, h5, h6, label, legend, strong, [role="heading"]';
          const seen = new Set<string>();
          const anchors: string[] = [];
          const lowerValue = currentValue.toLowerCase();

          for (const candidate of Array.from(scopeRoot.querySelectorAll(selectors))) {
            if (anchors.length >= 4) break;
            if (!(candidate instanceof HTMLElement) || !isVisible(candidate)) continue;
            if (candidate === editableElement || editableElement.contains(candidate)) continue;

            const text = shortVisibleText(candidate);
            if (!text) continue;
            const normalizedText = text.toLowerCase();
            if (excludedLabels.has(normalizedText)) continue;
            if (lowerValue && normalizedText === lowerValue) continue;
            if (seen.has(normalizedText)) continue;

            seen.add(normalizedText);
            anchors.push(text);
          }

          return anchors;
        };

        const collectNearbyConfusers = (
          scopeRoot: HTMLElement,
          editableElement: HTMLElement,
          currentValue: string,
          candidateLabels: Set<string>
        ): ScopeHintCandidate[] => {
          const seen = new Set<string>();
          const confusers: ScopeHintCandidate[] = [];
          const lowerValue = currentValue.toLowerCase();
          const selectors =
            'h1, h2, h3, h4, h5, h6, p, span, div, label, strong, em, a, [role="heading"], [role="note"], [role="text"]';

          for (const candidate of Array.from(scopeRoot.querySelectorAll(selectors))) {
            if (confusers.length >= 4) break;
            if (!(candidate instanceof HTMLElement) || !isVisible(candidate)) continue;
            if (candidate === editableElement || editableElement.contains(candidate)) continue;
            if (looksLikeSubmit(candidate)) continue;

            const label = shortVisibleText(candidate);
            if (!label) continue;
            const normalizedLabel = label.toLowerCase();
            if (candidateLabels.has(normalizedLabel)) continue;

            const role = roleOf(candidate);
            let warning = '';

            if (lowerValue && normalizedLabel === lowerValue) {
              warning = 'matches the current typed text; likely preview or read-only content';
            } else if (normalizedLabel === 'preview') {
              warning = 'preview heading, not the submit action';
            } else if (role === 'heading') {
              warning = 'heading near the active form, not a submit control';
            }

            if (!warning) {
              continue;
            }

            const dedupeKey = `${role}|${normalizedLabel}`;
            if (seen.has(dedupeKey)) {
              continue;
            }

            seen.add(dedupeKey);
            confusers.push({
              descriptor: describe(candidate),
              name: label,
              role,
              relation: 'nearby_confuser',
              warning,
            });
          }

          return confusers;
        };

        const describeScope = (
          scopeRoot: HTMLElement,
          anchors: string[],
          submitLabels: string[]
        ): string => {
          const base = describe(scopeRoot);
          const directLabel = labelOf(scopeRoot);
          if (directLabel) {
            return base;
          }
          if (anchors.length > 0) {
            return `${base} near "${anchors[0]}"`;
          }
          if (submitLabels.length > 0) {
            return `${base} with ${submitLabels[0]} action`;
          }
          return base;
        };

        const editable =
          (node instanceof HTMLElement && node.matches(editableSelector) ? node : null) ||
          (node instanceof HTMLElement ? node.closest(editableSelector) : null) ||
          (node instanceof HTMLElement ? node.querySelector(editableSelector) : null);

        if (!editable || !isVisible(editable)) {
          return null;
        }

        const submitAncestors: HTMLElement[] = [];
        let cursor: HTMLElement | null = editable;
        while (cursor && submitAncestors.length < 9) {
          submitAncestors.push(cursor);
          cursor = cursor.parentElement;
        }

        let selectedScope: HTMLElement | null = null;
        let candidates: Array<{ label: string; descriptor: string; role: string }> = [];

        for (const ancestor of submitAncestors) {
          const descendantButtons = Array.from(ancestor.querySelectorAll(buttonSelector))
            .filter((candidate) => candidate !== editable && !editable.contains(candidate))
            .filter((candidate) => isVisible(candidate))
            .filter((candidate) => looksLikeSubmit(candidate))
            .map((candidate) => ({
              label: labelOf(candidate),
              descriptor: describe(candidate),
              role: roleOf(candidate),
            }))
            .filter((candidate) => candidate.label.length > 0);

          if (descendantButtons.length === 0) {
            continue;
          }

          const role = roleOf(ancestor);
          const tag = ancestor.tagName.toLowerCase();
          const allowLargeScope =
            tag === 'form' ||
            tag === 'dialog' ||
            role === 'dialog' ||
            role === 'form' ||
            role === 'group' ||
            role === 'region';

          if (!allowLargeScope && descendantButtons.length > 6) {
            continue;
          }

          selectedScope = ancestor;
          candidates = descendantButtons.slice(0, 8);
          break;
        }

        if (!selectedScope || candidates.length === 0) {
          return null;
        }

        document.querySelectorAll(`[${payload.scopeAttr}]`).forEach((element) => {
          element.removeAttribute(payload.scopeAttr);
        });
        selectedScope.setAttribute(payload.scopeAttr, payload.scopeId);

        const uniqueLabels = Array.from(
          new Set(candidates.map((candidate) => candidate.label).filter((label) => label.length > 0))
        );
        const uniqueNormalizedLabels = new Set(uniqueLabels.map((label) => label.toLowerCase()));
        const currentValue = valueOf(editable);
        const contextAnchors = collectContextAnchors(selectedScope, editable, uniqueNormalizedLabels, currentValue);
        const nextActionHints: ScopeHintCandidate[] = candidates.slice(0, 4).map((candidate, index) => ({
          descriptor: candidate.descriptor,
          name: candidate.label,
          role: candidate.role,
          relation: 'same_scope_submit',
          recommended: index === 0,
        }));
        const nearbyConfusers = collectNearbyConfusers(
          selectedScope,
          editable,
          currentValue,
          uniqueNormalizedLabels
        );

        return {
          scopeId: payload.scopeId,
          pageUrl: payload.pageUrl,
          inputDescriptor: describe(editable),
          scopeKind: inferScopeKind(selectedScope, uniqueLabels),
          scopeDescriptor: describeScope(selectedScope, contextAnchors, uniqueLabels),
          submitCandidates: uniqueLabels,
          contextAnchors,
          resolvedTarget: {
            descriptor: describe(editable),
            name: labelOf(editable) || undefined,
            role: roleOf(editable) || undefined,
            valuePreview: currentValue || undefined,
          },
          nextActionHints,
          nearbyConfusers,
        };
      },
      { scopeAttr: ACTION_SCOPE_ATTR, scopeId, pageUrl: page.url() }
    );

    if (!scoped) {
      await this.clearScopedActionContext();
      return null;
    }

    this.scopedActionContext = {
      ...scoped,
      updatedAt: Date.now(),
    };
    return this.getScopedActionContext();
  }

  async rememberActionScopeFromTrigger(locator: Locator): Promise<ScopedActionContext | null> {
    const page = this.getPage();
    const scopeId = `scope_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const scoped = await locator.evaluate(
      (node: Element, payload: { scopeAttr: string; scopeId: string; pageUrl: string }) => {
        const normalize = (value: string | null | undefined): string =>
          (value || '').replace(/\s+/g, ' ').trim();
        const editableSelector =
          'input:not([type="hidden"]), textarea, [contenteditable=""], [contenteditable="true"], [role="textbox"]';
        const buttonSelector =
          'button, input[type="submit"], input[type="button"], [role="button"], a[role="button"]';
        const submitNamePattern =
          /^(post|save|submit|confirm|apply|create|update|publish|send|done|ok|reply|comment|search|go|continue|next)$/i;

        const isVisible = (element: Element | null): element is HTMLElement => {
          if (!(element instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0
          );
        };

        const labelOf = (element: Element): string => {
          const html = element as HTMLElement;
          const input = element as HTMLInputElement;
          return normalize(
            html.getAttribute('aria-label') ||
              html.getAttribute('title') ||
              html.innerText ||
              html.textContent ||
              input.value ||
              ''
          );
        };

        const roleOf = (element: Element): string =>
          normalize(element.getAttribute('role') || element.tagName.toLowerCase());

        const describe = (element: Element): string => {
          const role = roleOf(element) || 'generic';
          const label = labelOf(element);
          return label ? `${role} "${label}"` : role;
        };

        const valueOf = (element: Element): string => {
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            return normalize(element.value);
          }
          const html = element as HTMLElement;
          if (html.isContentEditable) {
            return normalize(html.innerText || html.textContent || '');
          }
          return normalize(html.innerText || html.textContent || '');
        };

        const looksLikeSubmit = (element: Element): boolean => {
          const tag = element.tagName.toLowerCase();
          const type =
            element instanceof HTMLInputElement ? normalize(element.type).toLowerCase() : '';
          const label = labelOf(element);
          if (tag === 'button') return true;
          if (tag === 'input' && (type === 'submit' || type === 'button')) return true;
          if (roleOf(element) === 'button' && submitNamePattern.test(label)) return true;
          return submitNamePattern.test(label);
        };

        const shortVisibleText = (element: Element): string => {
          const text = labelOf(element);
          if (!text || text.length > 80) {
            return '';
          }
          return text;
        };

        const inferScopeKind = (element: HTMLElement, submitLabels: string[]): string => {
          const tag = element.tagName.toLowerCase();
          const role = roleOf(element);
          const normalizedLabels = submitLabels.map((label) => label.toLowerCase());

          if (tag === 'form' || role === 'form') return 'form';
          if (tag === 'dialog' || role === 'dialog') return 'dialog';
          if (normalizedLabels.some((label) => ['post', 'reply', 'comment'].includes(label))) return 'composer';
          if (role === 'group') return 'group';
          if (role === 'region') return 'region';
          return role || tag || 'container';
        };

        const collectContextAnchors = (
          scopeRoot: HTMLElement,
          editableElement: HTMLElement,
          excludedLabels: Set<string>,
          currentValue: string
        ): string[] => {
          const selectors = 'a, h1, h2, h3, h4, h5, h6, label, legend, strong, [role="heading"]';
          const seen = new Set<string>();
          const anchors: string[] = [];
          const lowerValue = currentValue.toLowerCase();

          for (const candidate of Array.from(scopeRoot.querySelectorAll(selectors))) {
            if (anchors.length >= 4) break;
            if (!(candidate instanceof HTMLElement) || !isVisible(candidate)) continue;
            if (candidate === editableElement || editableElement.contains(candidate)) continue;

            const text = shortVisibleText(candidate);
            if (!text) continue;
            const normalizedText = text.toLowerCase();
            if (excludedLabels.has(normalizedText)) continue;
            if (lowerValue && normalizedText === lowerValue) continue;
            if (seen.has(normalizedText)) continue;

            seen.add(normalizedText);
            anchors.push(text);
          }

          return anchors;
        };

        const collectNearbyConfusers = (
          scopeRoot: HTMLElement,
          editableElement: HTMLElement,
          currentValue: string,
          candidateLabels: Set<string>
        ): ScopeHintCandidate[] => {
          const seen = new Set<string>();
          const confusers: ScopeHintCandidate[] = [];
          const lowerValue = currentValue.toLowerCase();
          const selectors =
            'h1, h2, h3, h4, h5, h6, p, span, div, label, strong, em, a, [role="heading"], [role="note"], [role="text"]';

          for (const candidate of Array.from(scopeRoot.querySelectorAll(selectors))) {
            if (confusers.length >= 4) break;
            if (!(candidate instanceof HTMLElement) || !isVisible(candidate)) continue;
            if (candidate === editableElement || editableElement.contains(candidate)) continue;
            if (looksLikeSubmit(candidate)) continue;

            const label = shortVisibleText(candidate);
            if (!label) continue;
            const normalizedLabel = label.toLowerCase();
            if (candidateLabels.has(normalizedLabel)) continue;

            const role = roleOf(candidate);
            let warning = '';

            if (lowerValue && normalizedLabel === lowerValue) {
              warning = 'matches the current typed text; likely preview or read-only content';
            } else if (normalizedLabel === 'preview') {
              warning = 'preview heading, not the submit action';
            } else if (role === 'heading') {
              warning = 'heading near the active form, not a submit control';
            }

            if (!warning) {
              continue;
            }

            const dedupeKey = `${role}|${normalizedLabel}`;
            if (seen.has(dedupeKey)) {
              continue;
            }

            seen.add(dedupeKey);
            confusers.push({
              descriptor: describe(candidate),
              name: label,
              role,
              relation: 'nearby_confuser',
              warning,
            });
          }

          return confusers;
        };

        const describeScope = (
          scopeRoot: HTMLElement,
          anchors: string[],
          submitLabels: string[]
        ): string => {
          const base = describe(scopeRoot);
          const directLabel = labelOf(scopeRoot);
          if (directLabel) {
            return base;
          }
          if (anchors.length > 0) {
            return `${base} near "${anchors[0]}"`;
          }
          if (submitLabels.length > 0) {
            return `${base} with ${submitLabels[0]} action`;
          }
          return base;
        };

        const trigger =
          (node instanceof HTMLElement && node) ||
          (node.parentElement instanceof HTMLElement ? node.parentElement : null);

        if (!trigger || !isVisible(trigger)) {
          return null;
        }

        const triggerRect = trigger.getBoundingClientRect();
        const selectableEditables = (root: HTMLElement): HTMLElement[] =>
          Array.from(root.querySelectorAll(editableSelector)).filter(
            (candidate) => candidate instanceof HTMLElement && isVisible(candidate) && candidate !== trigger
          ) as HTMLElement[];

        const submitCandidatesFor = (root: HTMLElement) =>
          Array.from(root.querySelectorAll(buttonSelector))
            .filter((candidate) => candidate !== trigger && !trigger.contains(candidate))
            .filter((candidate) => isVisible(candidate))
            .filter((candidate) => looksLikeSubmit(candidate));

        const scoreEditable = (candidate: HTMLElement): number => {
          const rect = candidate.getBoundingClientRect();
          const relation = trigger.compareDocumentPosition(candidate);
          const followsTrigger = !!(relation & Node.DOCUMENT_POSITION_FOLLOWING);
          const verticalDelta = rect.top - triggerRect.top;
          const horizontalDelta = Math.abs(rect.left - triggerRect.left);

          let score = 0;
          if (!followsTrigger) score += 10000;
          if (verticalDelta < -20) {
            score += 5000 + Math.abs(verticalDelta);
          } else {
            score += Math.abs(verticalDelta);
          }
          score += horizontalDelta * 0.25;
          return score;
        };

        const ancestors: HTMLElement[] = [];
        let cursor: HTMLElement | null = trigger;
        while (cursor && ancestors.length < 9) {
          ancestors.push(cursor);
          cursor = cursor.parentElement;
        }

        let selectedScope: HTMLElement | null = null;
        let selectedEditable: HTMLElement | null = null;
        let selectedButtons: Array<{ label: string; descriptor: string; role: string }> = [];

        for (const ancestor of ancestors) {
          const editables = selectableEditables(ancestor);
          const submitNodes = submitCandidatesFor(ancestor);

          if (editables.length === 0 || submitNodes.length === 0) {
            continue;
          }

          const role = roleOf(ancestor);
          const tag = ancestor.tagName.toLowerCase();
          const allowLargeScope =
            tag === 'form' ||
            tag === 'dialog' ||
            role === 'dialog' ||
            role === 'form' ||
            role === 'group' ||
            role === 'region';

          if (!allowLargeScope && submitNodes.length > 6) {
            continue;
          }

          const followingEditables = editables.filter((candidate) => scoreEditable(candidate) < 10000);
          const rankedEditables = (followingEditables.length > 0 ? followingEditables : editables)
            .slice()
            .sort((a, b) => scoreEditable(a) - scoreEditable(b));

          const buttons = submitNodes
            .map((candidate) => ({
              label: labelOf(candidate),
              descriptor: describe(candidate),
              role: roleOf(candidate),
            }))
            .filter((candidate) => candidate.label.length > 0)
            .slice(0, 8);

          if (rankedEditables.length === 0 || buttons.length === 0) {
            continue;
          }

          selectedScope = ancestor;
          selectedEditable = rankedEditables[0];
          selectedButtons = buttons;
          break;
        }

        if (!selectedScope || !selectedEditable || selectedButtons.length === 0) {
          return null;
        }

        document.querySelectorAll(`[${payload.scopeAttr}]`).forEach((element) => {
          element.removeAttribute(payload.scopeAttr);
        });
        selectedScope.setAttribute(payload.scopeAttr, payload.scopeId);

        const uniqueLabels = Array.from(
          new Set(selectedButtons.map((candidate) => candidate.label).filter((label) => label.length > 0))
        );
        const uniqueNormalizedLabels = new Set(uniqueLabels.map((label) => label.toLowerCase()));
        const currentValue = valueOf(selectedEditable);
        const contextAnchors = collectContextAnchors(
          selectedScope,
          selectedEditable,
          uniqueNormalizedLabels,
          currentValue
        );
        const nextActionHints: ScopeHintCandidate[] = selectedButtons.slice(0, 4).map((candidate, index) => ({
          descriptor: candidate.descriptor,
          name: candidate.label,
          role: candidate.role,
          relation: 'same_scope_submit',
          recommended: index === 0,
        }));
        const nearbyConfusers = collectNearbyConfusers(
          selectedScope,
          selectedEditable,
          currentValue,
          uniqueNormalizedLabels
        );

        return {
          scopeId: payload.scopeId,
          pageUrl: payload.pageUrl,
          inputDescriptor: describe(selectedEditable),
          scopeKind: inferScopeKind(selectedScope, uniqueLabels),
          scopeDescriptor: describeScope(selectedScope, contextAnchors, uniqueLabels),
          submitCandidates: uniqueLabels,
          contextAnchors,
          resolvedTarget: {
            descriptor: describe(selectedEditable),
            name: labelOf(selectedEditable) || undefined,
            role: roleOf(selectedEditable) || undefined,
            valuePreview: currentValue || undefined,
          },
          nextActionHints,
          nearbyConfusers,
        };
      },
      { scopeAttr: ACTION_SCOPE_ATTR, scopeId, pageUrl: page.url() }
    ).catch(() => null);

    if (!scoped) {
      return null;
    }

    this.scopedActionContext = {
      ...scoped,
      updatedAt: Date.now(),
    };
    return this.getScopedActionContext();
  }

  async resolveScopedEditableLocator(hints: string[]): Promise<Locator | null> {
    if (!this.scopedActionContext) {
      return null;
    }

    const page = this.getPage();
    if (page.url() !== this.scopedActionContext.pageUrl) {
      await this.clearScopedActionContext();
      return null;
    }

    const scopeRoot = page.locator(`[${ACTION_SCOPE_ATTR}="${this.scopedActionContext.scopeId}"]`).first();
    const scopeExists = await scopeRoot.count().catch(() => 0);
    if (scopeExists <= 0) {
      await this.clearScopedActionContext();
      return null;
    }

    const normalizedHints = Array.from(
      new Set(
        [
          this.scopedActionContext.resolvedTarget?.name || '',
          ...hints,
        ]
          .map((value) => this.normalizeRecipeName(value))
          .filter((value) => value.length > 0)
      )
    );

    const candidates: Locator[] = [];
    for (const hint of normalizedHints) {
      candidates.push(scopeRoot.getByRole('textbox', { name: hint, exact: true }).first());
      candidates.push(scopeRoot.getByRole('textbox', { name: hint }).first());
      candidates.push(scopeRoot.getByLabel(hint, { exact: true }).first());
      candidates.push(scopeRoot.getByLabel(hint).first());
      candidates.push(scopeRoot.getByPlaceholder(hint, { exact: true }).first());
      candidates.push(scopeRoot.getByPlaceholder(hint).first());
    }

    for (const candidate of candidates) {
      try {
        const count = await candidate.count();
        if (count <= 0) continue;
        if (!(await candidate.isVisible().catch(() => false))) continue;
        return candidate;
      } catch {
        continue;
      }
    }

    const genericEditables = [
      scopeRoot.locator('textarea:visible').first(),
      scopeRoot.locator('input:not([type="hidden"]):visible').first(),
      scopeRoot.locator('[role="textbox"]:visible').first(),
      scopeRoot.locator('[contenteditable=""], [contenteditable="true"]').first(),
    ];

    let visibleEditables = 0;
    let lastVisible: Locator | null = null;
    for (const candidate of genericEditables) {
      try {
        const count = await candidate.count();
        if (count <= 0) continue;
        if (!(await candidate.isVisible().catch(() => false))) continue;
        visibleEditables += 1;
        lastVisible = candidate;
      } catch {
        continue;
      }
    }

    if (visibleEditables === 1 && lastVisible) {
      return lastVisible;
    }

    return null;
  }

  async resolveScopedActionLocator(targetName: string, roleHint?: string): Promise<Locator | null> {
    if (!this.scopedActionContext) {
      return null;
    }

    const page = this.getPage();
    if (page.url() !== this.scopedActionContext.pageUrl) {
      await this.clearScopedActionContext();
      return null;
    }

    const scopeRoot = page.locator(`[${ACTION_SCOPE_ATTR}="${this.scopedActionContext.scopeId}"]`).first();
    const scopeExists = await scopeRoot.count().catch(() => 0);
    if (scopeExists <= 0) {
      await this.clearScopedActionContext();
      return null;
    }

    const normalizedTarget = this.normalizeRecipeName(targetName);
    const normalizedRole = typeof roleHint === 'string' ? roleHint.toLowerCase() : '';
    const candidates: Locator[] = [];

    if (normalizedTarget) {
      if (normalizedRole) {
        candidates.push(scopeRoot.getByRole(roleHint as any, { name: normalizedTarget, exact: true }).first());
        candidates.push(scopeRoot.getByRole(roleHint as any, { name: normalizedTarget }).first());
      }

      candidates.push(scopeRoot.getByRole('button', { name: normalizedTarget, exact: true }).first());
      candidates.push(scopeRoot.getByRole('button', { name: normalizedTarget }).first());
      candidates.push(
        scopeRoot.locator(`input[type="submit"][value="${normalizedTarget}"], input[type="button"][value="${normalizedTarget}"]`).first()
      );
      candidates.push(
        scopeRoot
          .locator('button, input[type="submit"], input[type="button"], [role="button"], a[role="button"]')
          .filter({ hasText: normalizedTarget })
          .first()
      );
    }

    if (!normalizedTarget && this.scopedActionContext.submitCandidates.length === 1) {
      const onlyCandidate = this.scopedActionContext.submitCandidates[0];
      candidates.push(scopeRoot.getByRole('button', { name: onlyCandidate, exact: true }).first());
      candidates.push(
        scopeRoot.locator(`input[type="submit"][value="${onlyCandidate}"], input[type="button"][value="${onlyCandidate}"]`).first()
      );
    }

    const resolved = await this.firstExistingLocator(candidates);
    if (resolved) {
      return resolved;
    }

    return null;
  }

  private normalizeRecipeName(value: unknown): string {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim();
  }

  private isInputLikeRole(role: string): boolean {
    const normalized = role.toLowerCase();
    return normalized === 'textbox' || normalized === 'searchbox' || normalized === 'combobox';
  }

  private async firstExistingLocator(candidates: Locator[]): Promise<Locator | null> {
    for (const locator of candidates) {
      try {
        const count = await locator.count();
        if (count > 0) {
          return locator;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  private preferredLocator(locator: Locator, matchIndex: number | undefined): Locator {
    if (Number.isFinite(matchIndex) && (matchIndex as number) >= 0) {
      return locator.nth(matchIndex as number);
    }
    return locator.first();
  }

  private async resolveLocatorByRecipe(recipe: LocatorRecipe): Promise<Locator | null> {
    const page = this.getPage();
    const normalizedName = this.normalizeRecipeName(recipe.name);
    const normalizedRole = typeof recipe.role === 'string' ? recipe.role.toLowerCase() : '';
    const preferredIndex = Number.isFinite(recipe.matchIndex) ? Number(recipe.matchIndex) : undefined;

    // 策略 1: 文本节点
    if (normalizedRole === 'text' || normalizedRole === 'generic') {
      if (normalizedName) {
        const directText = await this.firstExistingLocator([
          this.preferredLocator(page.getByText(normalizedName, { exact: true }), preferredIndex),
          this.preferredLocator(page.getByText(normalizedName), preferredIndex),
        ]);
        if (directText) {
          return directText;
        }
      }
    }

    // 策略 2: 标准交互元素（按优先级顺序探测，避免 or(...).first() 的 DOM 顺序误选）
    if (normalizedRole && normalizedName) {
      const roleCandidates: Locator[] = [
        this.preferredLocator(page.getByRole(recipe.role as any, { name: normalizedName, exact: true }), preferredIndex),
        this.preferredLocator(page.getByRole(recipe.role as any, { name: normalizedName }), preferredIndex),
      ];

      if (this.isInputLikeRole(normalizedRole)) {
        roleCandidates.push(this.preferredLocator(page.getByLabel(normalizedName, { exact: true }), preferredIndex));
        roleCandidates.push(this.preferredLocator(page.getByLabel(normalizedName), preferredIndex));
        roleCandidates.push(this.preferredLocator(page.getByPlaceholder(normalizedName, { exact: true }), preferredIndex));
        roleCandidates.push(this.preferredLocator(page.getByPlaceholder(normalizedName), preferredIndex));
      } else {
        roleCandidates.push(this.preferredLocator(page.getByText(normalizedName, { exact: true }), preferredIndex));
        roleCandidates.push(
          this.preferredLocator(
            page
              .locator('a,button,[role],[tabindex]')
              .filter({ hasText: normalizedName }),
            preferredIndex
          )
        );
      }

      const resolvedByRoleAndName = await this.firstExistingLocator(roleCandidates);
      if (resolvedByRoleAndName) {
        return resolvedByRoleAndName;
      }
    }

    // 策略 3: 只有 Role
    if (recipe.role) {
      const roleOnly = await this.firstExistingLocator([this.preferredLocator(page.getByRole(recipe.role as any), preferredIndex)]);
      if (roleOnly) {
        return roleOnly;
      }
    }

    // 策略 4: 仅名称兜底（避免把输入控件误匹配到链接）
    if (normalizedName) {
      const textFallback = await this.firstExistingLocator([
        this.preferredLocator(page.getByText(normalizedName, { exact: true }), preferredIndex),
      ]);
      if (textFallback) {
        return textFallback;
      }
    }

    return null;
  }

  /**
   * 获取当前的 ref 缓存（供外部使用）
   */
  getRefCache() {
    if (!this.snapshotter) throw new Error('Snapshotter not initialized');
    return this.snapshotter.refs;
  }

  async getViewportState(): Promise<VisualInspectionPageState> {
    const page = this.getPage();
    const fallbackUrl = page.url();
    const viewportInfo = await page.evaluate(() => ({
      url: window.location.href,
      widthCssPx: Math.max(window.innerWidth || 0, document.documentElement?.clientWidth || 0),
      heightCssPx: Math.max(window.innerHeight || 0, document.documentElement?.clientHeight || 0),
      scrollX: Math.round(window.scrollX || 0),
      scrollY: Math.round(window.scrollY || 0),
    })).catch(() => ({
      url: fallbackUrl,
      widthCssPx: 0,
      heightCssPx: 0,
      scrollX: 0,
      scrollY: 0,
    }));

    const tabId = await this.resolvePageTabId(page);
    return {
      url: viewportInfo.url || fallbackUrl,
      widthCssPx: viewportInfo.widthCssPx,
      heightCssPx: viewportInfo.heightCssPx,
      scrollX: viewportInfo.scrollX,
      scrollY: viewportInfo.scrollY,
      tabId,
    };
  }

  storeVisualInspection(inspection: StoredVisualInspection) {
    this.visualInspections.set(inspection.inspectionId, inspection);
    if (this.visualInspections.size <= VISUAL_INSPECTION_CACHE_SIZE) {
      return;
    }

    const inspections = Array.from(this.visualInspections.values())
      .sort((a, b) => a.createdAt - b.createdAt);
    while (inspections.length > VISUAL_INSPECTION_CACHE_SIZE) {
      const oldest = inspections.shift();
      if (!oldest) break;
      this.visualInspections.delete(oldest.inspectionId);
    }
  }

  getVisualInspection(inspectionId: string): StoredVisualInspection | null {
    return this.visualInspections.get(inspectionId) || null;
  }

  /**
   * 重新附加到当前激活的页面
   * 当用户在 Electron 中切换 Tab 时调用
   */
  async reattach(tabId?: number) {
    await this.clearScopedActionContext();
    if (!this.context) {
      throw new Error('Browser context not initialized');
    }

    // 获取所有页面
    const pages = this.context.pages();
    
    // 打印所有页面供调试
    pages.forEach((p, i) => console.log(`[Page ${i}] ${p.url()}`));

    let selectedPage: Page | null = null;

    if (typeof tabId === 'number') {
      this.lastDesktopTabId = tabId;
      selectedPage = await this.findPageByTabId(pages, tabId);
      if (selectedPage) {
        console.log(`[BrowserSession] Re-selected page by tab id ${tabId}: ${selectedPage.url()}`);
      } else {
        console.warn(`[BrowserSession] No page matched tab id ${tabId}, falling back`);
      }
    }

    if (!selectedPage) {
      if (typeof tabId === 'number' && this.page && !this.page.isClosed()) {
        selectedPage = this.page;
      }
    }

    if (!selectedPage) {
      const tabIdPage = await this.findPageWithTabId(pages);
      if (tabIdPage) {
        selectedPage = tabIdPage;
        const cachedTabId = this.getCachedTabId(tabIdPage);
        if (typeof cachedTabId === 'number') {
          this.lastDesktopTabId = cachedTabId;
        }
        console.log(`[BrowserSession] Re-selected tab page: ${selectedPage.url()}`);
      } else {
        // 优先查找带有 BrowserView 标记的页面
        const browserViewPage = pages.find(p => p.url().includes('about:blank#browser-view'));
        if (browserViewPage) {
          selectedPage = browserViewPage;
          console.log(`[BrowserSession] Re-selected BrowserView page: ${selectedPage.url()}`);
        } else {
          // 过滤掉 UI 页面
          const validPages = pages.filter(p => !this.isUiPage(p.url()));

          if (validPages.length > 0) {
            // 优先接管非 UI 页面
            selectedPage = validPages[0];
            console.log(`[BrowserSession] Re-selected target page: ${selectedPage.url()}`);
          } else if (pages.length > 0) {
            // 如果实在没别的，尝试找到 about:blank 页面（BrowserView 初始页面）
            const blankPage = pages.find(p => p.url() === 'about:blank');
            if (blankPage) {
              selectedPage = blankPage;
              console.log(`[BrowserSession] Re-selected about:blank page: ${selectedPage.url()}`);
            } else {
              // 兜底：使用第一个页面，但记录警告
              selectedPage = pages[0];
              console.warn(`[BrowserSession] No valid content page found, using pages[0]: ${selectedPage.url()}`);
            }
          } else {
            // 如果没有任何页面，新建一个
            selectedPage = await this.context.newPage();
            console.log(`[BrowserSession] Created new page: ${selectedPage.url()}`);
          }
        }
      }
    }

    this.page = selectedPage;

    console.log(`[BrowserSession] Reattached to page: ${this.page.url()}`);
    this.snapshotter = new Snapshotter(this.page);
  }

  /**
   * 激活当前页面（带到前台）
   */
  async activate() {
    let page: Page | null = null;
    try {
      page = this.getPage();
    } catch (e) {
      console.warn('[BrowserSession] Failed to resolve page for activation', e);
      return;
    }

    try {
      await page.bringToFront();
      console.log(`[BrowserSession] Brought page to front: ${page.url()}`);
    } catch (e) {
      console.warn('[BrowserSession] Failed to bring page to front', e);
    }

    await this.notifyDesktopTabActive(page);
  }

  private async resolvePageTabId(page: Page): Promise<number | null> {
    const cached = this.pageTabIdCache.get(page);
    if (typeof cached === 'number') return cached;
    if (page.isClosed()) return null;

    try {
      const tabId = await page.evaluate((prop) => {
        return (window as any)[prop];
      }, TAB_ID_WINDOW_PROPERTY);
      if (typeof tabId === 'number') {
        this.pageTabIdCache.set(page, tabId);
        return tabId;
      }
    } catch (e) {
      // Ignore evaluation failures; fall back to other heuristics.
    }

    return null;
  }

  private async findPageByTabId(pages: Page[], tabId: number): Promise<Page | null> {
    for (const page of pages) {
      const candidateId = await this.resolvePageTabId(page);
      if (candidateId === tabId) return page;
    }
    return null;
  }

  private async findPageWithTabId(pages: Page[]): Promise<Page | null> {
    for (const page of pages) {
      const candidateId = await this.resolvePageTabId(page);
      if (typeof candidateId === 'number') return page;
    }
    return null;
  }

  private getCachedTabId(page: Page): number | null {
    const cached = this.pageTabIdCache.get(page);
    return typeof cached === 'number' ? cached : null;
  }

  private findPageByCachedTabId(pages: Page[], tabId: number): Page | null {
    for (const page of pages) {
      const cached = this.getCachedTabId(page);
      if (cached === tabId) return page;
    }
    return null;
  }

  private findAnyPageWithCachedTabId(pages: Page[]): Page | null {
    for (const page of pages) {
      if (typeof this.getCachedTabId(page) === 'number') return page;
    }
    return null;
  }

  private getPageIndex(page: Page): number | null {
    const pages = this.context?.pages();
    if (!pages) return null;
    const index = pages.indexOf(page);
    return index === -1 ? null : index;
  }

  private async notifyDesktopTabActive(page: Page) {
    if (!this.isAttached) return;

    const controlUrl = getDesktopControlUrl();
    if (!controlUrl) return;

    const tabId = await this.resolvePageTabId(page);
    if (typeof tabId === 'number') {
      if (this.lastDesktopTabId === tabId) return;
      try {
        await axios.post(`${controlUrl}/tabs/select`, { id: tabId });
        this.lastDesktopTabId = tabId;
      } catch (e) {
        console.warn('[BrowserSession] Failed to notify Desktop tab select', e);
      }
      return;
    }

    const index = this.getPageIndex(page);
    if (index === null) return;
    try {
      await axios.post(`${controlUrl}/tabs/select`, { index });
    } catch (e) {
      console.warn('[BrowserSession] Failed to notify Desktop tab select', e);
    }
  }

  /**
   * 获取所有标签页信息
   */
  async getTabsInfo() {
    if (!this.context) return [];
    const pages = this.getContentPages();
    const desktopActive = await this.fetchDesktopActiveTabInfo();
    if (desktopActive && typeof desktopActive.id === 'number') {
      this.lastDesktopTabId = desktopActive.id;
    }

    const tabDetails = await Promise.all(pages.map(async (p, index) => {
      const title = await p.title().catch(() => 'Untitled');
      const url = p.url();
      const tabId = await this.resolvePageTabId(p);
      return { index, title, url, tabId, page: p };
    }));

    let activePage: Page | null = null;
    if (desktopActive && typeof desktopActive.id === 'number') {
      const idMatch = tabDetails.find(t => typeof t.tabId === 'number' && t.tabId === desktopActive.id);
      if (idMatch) {
        activePage = idMatch.page;
      } else if (desktopActive.url) {
        const urlMatch = tabDetails.find(t => t.url === desktopActive.url);
        if (urlMatch) {
          activePage = urlMatch.page;
        }
      }
    }

    if (!activePage) {
      activePage = await this.resolveActiveContentPage(pages);
    }

    return tabDetails.map(({ index, title, url, page }) => ({
      index,
      title,
      url,
      isActive: page === activePage
    }));
  }

  getContentPages(): Page[] {
    if (!this.context) return [];
    return this.context.pages().filter(p => !this.isUiPage(p.url()));
  }

  getActiveTabId(): number | null {
    return this.lastDesktopTabId;
  }

  private async fetchDesktopActiveTabInfo(): Promise<{ id: number; url?: string; title?: string } | null> {
    if (!this.isAttached) return null;
    const controlUrl = getDesktopControlUrl();
    if (!controlUrl) return null;
    try {
      const response = await axios.get(`${controlUrl}/tabs/active`, { timeout: 1000 });
      const data = response.data?.data;
      if (response.data?.success && data && typeof data.id === 'number') {
        return data;
      }
    } catch (e) {
      console.warn('[BrowserSession] Failed to fetch Desktop active tab', e);
    }
    return null;
  }

  async getPageTabId(page: Page): Promise<number | null> {
    return this.resolvePageTabId(page);
  }

  async resolveActiveContentPage(pages: Page[]): Promise<Page | null> {
    const activeTabId = this.lastDesktopTabId;
    if (typeof activeTabId === 'number') {
      for (const page of pages) {
        const tabId = await this.resolvePageTabId(page);
        if (tabId === activeTabId) {
          return page;
        }
      }
    }

    for (const page of pages) {
      const visibility = await page
        .evaluate(() => document.visibilityState)
        .catch(() => null);
      if (visibility === 'visible') {
        return page;
      }
    }

    if (this.page && !this.page.isClosed()) {
      return this.page;
    }

    return pages[0] || null;
  }

  async switchToPageByReference(targetPage: Page) {
    if (!this.context) throw new Error('Context not initialized');
    if (targetPage.isClosed()) {
      throw new Error('Target page is closed');
    }
    await this.clearScopedActionContext();
    await targetPage.bringToFront();
    this.page = targetPage;
    this._setupListeners(this.page);
    this.snapshotter = new Snapshotter(this.page);
    const index = this.getPageIndex(targetPage);
    const indexLabel = typeof index === 'number' ? index : 'unknown';
    console.log(`[BrowserSession] Switched to page [${indexLabel}]: ${targetPage.url()}`);
  }

  /**
   * 手动切换到指定索引的页面
   */
  async switchToPage(index: number) {
    if (!this.context) throw new Error('Context not initialized');
    const pages = this.context.pages();
    if (index < 0 || index >= pages.length) {
      throw new Error(`Invalid page index ${index}`);
    }
    const targetPage = pages[index];
    await this.clearScopedActionContext();
    await targetPage.bringToFront();
    this.page = targetPage; // 核心：更新内部引用
    this._setupListeners(this.page); // 重新绑定监听
    this.snapshotter = new Snapshotter(this.page); // 重置快照器
    console.log(`[BrowserSession] Switched to page [${index}]: ${targetPage.url()}`);
  }

  /**
   * 设置页面事件监听器
   */
  private _setupListeners(page: Page) {
    // 先解绑，避免重复绑定导致的重复处理
    page.off('console', this.onConsole);
    page.off('dialog', this.onDialog);
    page.off('request', this.onRequest);

    page.on('console', this.onConsole);
    page.on('dialog', this.onDialog);
    page.on('request', this.onRequest);
  }
  
  /**
   * 获取控制台日志
   */
  getConsoleLogs() {
    return [...this.consoleLogs];
  }
  
  /**
   * 清空控制台日志
   */
  clearConsoleLogs() {
    this.consoleLogs = [];
  }
  
  /**
   * 设置下一个对话框的处理方式
   */
  setNextDialogAction(action: { accept: boolean, promptText?: string }) {
    this.nextDialogAction = action;
  }
  
  /**
   * 获取网络请求日志
   */
  getNetworkLogs() {
    return [...this.networkLogs];
  }

  getVisitedOrigins(): string[] {
    return Array.from(this.visitedOrigins.keys());
  }

  getActiveOrigin(): string | null {
    const currentUrl = this.page?.url();
    const current = currentUrl ? this.extractHttpOrigin(currentUrl) : null;
    return current || this.activeOrigin;
  }

  private async withStoragePage<T>(origin: string, handler: (page: Page) => Promise<T>): Promise<T> {
    if (!this.context) {
      throw new Error('Context not initialized');
    }
    const page = await this.context.newPage();
    this.internalPages.add(page);
    try {
      await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 8000 });
      const landedOrigin = this.extractHttpOrigin(page.url());
      if (!landedOrigin || landedOrigin !== origin) {
        throw new Error(`Origin mismatch: expected ${origin} but landed on ${page.url()}`);
      }
      return await handler(page);
    } finally {
      try {
        await page.close();
      } catch {
        // ignore
      }
    }
  }

  private async readLocalStorageForOrigin(origin: string): Promise<Record<string, string> | null> {
    const normalized = this.extractHttpOrigin(origin);
    if (!normalized) return null;
    const existing = this.findExistingPageForOrigin(normalized);
    if (existing) {
      try {
        const entries = await this.readLocalStorageFromPage(existing);
        this.localStorageCache.set(normalized, { ...entries });
        return entries || {};
      } catch (e) {
        console.warn(`[BrowserSession] Failed to read localStorage for ${origin}: ${String(e)}`);
        return null;
      }
    }
    if (this.isAttached) {
      const cached = this.localStorageCache.get(normalized);
      return cached ? { ...cached } : null;
    }
    try {
      return await this.withStoragePage(normalized, async (page) => {
        const entries = await this.readLocalStorageFromPage(page);
        this.localStorageCache.set(normalized, { ...entries });
        return entries || {};
      });
    } catch (e) {
      console.warn(`[BrowserSession] Failed to read localStorage for ${origin}: ${String(e)}`);
      return null;
    }
  }

  private async writeLocalStorageForOrigin(
    origin: string,
    entries: Record<string, string>,
    mergePolicy: StorageStateMergePolicy
  ): Promise<boolean> {
    const normalized = this.extractHttpOrigin(origin);
    if (!normalized) return false;
    const existing = this.findExistingPageForOrigin(normalized);
    if (existing) {
      try {
        await this.writeLocalStorageToPage(existing, entries, mergePolicy);
        this.mergeLocalStorageCache(normalized, entries, mergePolicy);
        return true;
      } catch (e) {
        console.warn(`[BrowserSession] Failed to write localStorage for ${origin}: ${String(e)}`);
        return false;
      }
    }
    if (this.isAttached) {
      this.mergeLocalStorageCache(normalized, entries, mergePolicy);
      return false;
    }
    try {
      await this.withStoragePage(normalized, async (page) => {
        await this.writeLocalStorageToPage(page, entries, mergePolicy);
        this.mergeLocalStorageCache(normalized, entries, mergePolicy);
      });
      return true;
    } catch (e) {
      console.warn(`[BrowserSession] Failed to write localStorage for ${origin}: ${String(e)}`);
      return false;
    }
  }

  async exportStorageState(scope: StorageStateScope = 'visited-origins'): Promise<StorageStatePayload> {
    if (!this.context) {
      throw new Error('Context not initialized');
    }
    const cookies = await this.context.cookies();
    const activeOrigin = this.getActiveOrigin();
    const origins = scope === 'active-only'
      ? (activeOrigin ? [activeOrigin] : [])
      : this.getVisitedOrigins();

    const localStorage: LocalStorageMap = {};
    for (const origin of origins) {
      const data = await this.readLocalStorageForOrigin(origin);
      if (data !== null) {
        localStorage[origin] = data;
      } else {
        const normalized = this.extractHttpOrigin(origin);
        if (normalized) {
          const cached = this.localStorageCache.get(normalized);
          if (cached) {
            localStorage[origin] = { ...cached };
          }
        }
      }
    }

    return {
      cookies,
      localStorage,
      visitedOrigins: this.getVisitedOrigins(),
      activeOrigin
    };
  }

  async importStorageState(
    payload: { cookies?: any[]; localStorage?: LocalStorageMap },
    mergePolicy: StorageStateMergePolicy = 'merge'
  ): Promise<{ cookies: number; origins: number }> {
    if (!this.context) {
      throw new Error('Context not initialized');
    }
    const cookies = Array.isArray(payload.cookies) ? payload.cookies : [];
    if (cookies.length) {
      try {
        await this.context.addCookies(cookies);
      } catch (e) {
        console.warn('[BrowserSession] Failed to import cookies:', e);
      }
    }

    let originsApplied = 0;
    const localStorage = payload.localStorage || {};
    for (const [origin, entries] of Object.entries(localStorage)) {
      if (!entries || typeof entries !== 'object') continue;
      const normalized = this.extractHttpOrigin(origin);
      if (normalized) {
        this.mergeLocalStorageCache(normalized, entries, mergePolicy);
        this.pendingLocalStorage.set(normalized, { entries: { ...entries }, policy: mergePolicy });
      }
      const ok = await this.writeLocalStorageForOrigin(origin, entries, mergePolicy);
      if (ok) originsApplied += 1;
    }

    if (this.isAttached) {
      await this.installLocalStorageInitScript(this.buildLocalStorageSnapshot());
    }

    return { cookies: cookies.length, origins: originsApplied };
  }

  async clearStorageState(options: { cookies?: boolean; localStorage?: boolean }): Promise<{ cookiesCleared: boolean; originsCleared: number }> {
    if (!this.context) {
      throw new Error('Context not initialized');
    }
    const clearCookies = options.cookies !== false;
    const clearLocalStorage = options.localStorage !== false;

    if (clearCookies) {
      try {
        await this.context.clearCookies();
      } catch (e) {
        console.warn('[BrowserSession] Failed to clear cookies:', e);
      }
    }

    let originsCleared = 0;
    if (clearLocalStorage) {
      const origins = this.getVisitedOrigins();
      for (const origin of origins) {
        const ok = await this.writeLocalStorageForOrigin(origin, {}, 'replace_origin');
        if (ok) originsCleared += 1;
      }
    }

    return { cookiesCleared: clearCookies, originsCleared };
  }
}

// 简单的内存存储
export class SessionManager {
  private static instance: SessionManager;
  private sessions: Map<string, BrowserSession> = new Map();

  static getInstance() {
    if (!this.instance) this.instance = new SessionManager();
    return this.instance;
  }

  async createSession(options: SessionInitOptions = {}): Promise<BrowserSession> {
    const session = new BrowserSession('SUB', DEFAULT_MAX_VISITED_ORIGINS);
    await session.init(options);
    this.sessions.set(session.id, session);
    console.log(`[SessionManager] Created ${session.kind} session: ${session.id}`);
    return session;
  }
  
  // [新增] 连接到 CDP
  async attachSession(cdpEndpoint: string): Promise<BrowserSession> {
    const session = new BrowserSession('MAIN', DEFAULT_MAX_VISITED_ORIGINS);
    await session.attach(cdpEndpoint);
    this.sessions.set(session.id, session);
    console.log(`[SessionManager] Attached ${session.kind} session: ${session.id}`);
    return session;
  }

  getSession(id: string) {
    return this.sessions.get(id);
  }

  async closeSession(id: string) {
    const session = this.sessions.get(id);
    if (session) {
      await session.close();
      this.sessions.delete(id);
    }
  }

  async closeAll() {
    if (this.sessions.size === 0) return;
    const entries = Array.from(this.sessions.entries());
    await Promise.allSettled(
      entries.map(async ([id, session]) => {
        try {
          await session.close();
        } catch (error) {
          console.error(`[SessionManager] Failed to close session ${id}:`, error);
        }
      })
    );
    this.sessions.clear();
  }
}
