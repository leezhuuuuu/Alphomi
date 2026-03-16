import express from 'express';
import cors from 'cors';
import { marked } from 'marked';
import { SessionManager } from './core/session';
import { ToolHandlers } from './handlers';
import { TOOLS, ToolName } from '../common/tools';
import { isToolEnabled } from '../common/tool-settings';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { createErrorResponse, ErrorCode, ErrorResponse } from '../types/error';
import { loadConfigFromYaml } from '../common/config';
import { getRenderDoc } from './render_store';

loadConfigFromYaml('driver');

const app = express();
app.use(express.json({ limit: '10mb' })); // 截图可能很大
app.use(cors());

const sessionManager = SessionManager.getInstance();

// 1. 健康检查
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// 2. 获取工具列表 (REST API 能力源头)
app.get('/tools', (req, res) => {
  const includeDisabled = req.query.includeDisabled === '1' || req.query.includeDisabled === 'true'
  // 将 Zod 定义转换为 JSON Schema
  const tools = Object.values(TOOLS)
    .map((tool: any) => ({
      name: tool.name,
      description: tool.description,
      category: tool.category || null,
      enabled: isToolEnabled(tool.name),
      inputSchema: zodToJsonSchema(tool.inputSchema)
    }))
    .filter((tool) => includeDisabled || tool.enabled)
  res.json({ success: true, data: { tools } });
});

// 2.5 渲染 Markdown 页面
app.get('/render/md/:id', async (req, res) => {
  const { id } = req.params;
  const doc = getRenderDoc(id);
  if (!doc) {
    res.status(404).send('Not Found');
    return;
  }

  const safeTitle = doc.title || 'Markdown Preview';
  const html = doc.html || (await marked.parse(doc.markdown || '') as string);
  const theme = doc.theme || 'system';

  const exportHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #ffffff;
      --fg: #111111;
      --muted: #666666;
      --border: #e5e5e5;
      --card: #f7f7f7;
      --code-bg: #f3f3f3;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f1115;
        --fg: #e6e6e6;
        --muted: #a0a0a0;
        --border: #2a2f38;
        --card: #161a22;
        --code-bg: #1d2230;
      }
    }
    html[data-theme="light"] {
      --bg: #ffffff;
      --fg: #111111;
      --muted: #666666;
      --border: #e5e5e5;
      --card: #f7f7f7;
      --code-bg: #f3f3f3;
    }
    html[data-theme="dark"] {
      --bg: #0f1115;
      --fg: #e6e6e6;
      --muted: #a0a0a0;
      --border: #2a2f38;
      --card: #161a22;
      --code-bg: #1d2230;
    }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--fg);
    }
    .content {
      max-width: 900px;
      margin: 28px auto;
      padding: 0 24px 48px 24px;
      line-height: 1.6;
    }
    pre, code {
      background: var(--code-bg);
      padding: 2px 4px;
      border-radius: 4px;
    }
    pre {
      padding: 12px;
      overflow: auto;
    }
    a { color: inherit; }
  </style>
</head>
<body>
  <div class="content">${html}</div>
</body>
</html>`;

  const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="render-page" content="markdown-preview" />
  <title>${safeTitle}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #ffffff;
      --fg: #111111;
      --muted: #667085;
      --border: #e5e7eb;
      --card: #f8fafc;
      --code-bg: #f3f4f6;
      --accent: #2563eb;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0b0f14;
        --fg: #e5e7eb;
        --muted: #9aa4b2;
        --border: #1f2937;
        --card: #121826;
        --code-bg: #0f172a;
        --accent: #60a5fa;
      }
    }
    html[data-theme="light"] {
      --bg: #ffffff;
      --fg: #111111;
      --muted: #667085;
      --border: #e5e7eb;
      --card: #f8fafc;
      --code-bg: #f3f4f6;
      --accent: #2563eb;
    }
    html[data-theme="dark"] {
      --bg: #0b0f14;
      --fg: #e5e7eb;
      --muted: #9aa4b2;
      --border: #1f2937;
      --card: #121826;
      --code-bg: #0f172a;
      --accent: #60a5fa;
    }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--fg);
    }
    .toolbar {
      position: sticky;
      top: 0;
      z-index: 10;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 20px;
      border-bottom: 1px solid var(--border);
      background: color-mix(in srgb, var(--bg) 92%, transparent);
      backdrop-filter: blur(8px);
    }
    .toolbar h1 {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
    }
    .toolbar button {
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--fg);
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
    }
    .toolbar button.primary {
      border-color: color-mix(in srgb, var(--accent) 60%, var(--border));
      background: color-mix(in srgb, var(--accent) 16%, var(--card));
      color: var(--fg);
    }
    .toolbar button:hover {
      border-color: color-mix(in srgb, var(--accent) 50%, var(--border));
    }
    .toolbar .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .content {
      max-width: 900px;
      margin: 28px auto;
      padding: 0 24px 48px 24px;
      line-height: 1.7;
    }
    pre, code {
      background: var(--code-bg);
      padding: 2px 4px;
      border-radius: 4px;
    }
    pre {
      padding: 12px;
      overflow: auto;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    h1, h2, h3, h4, h5, h6 { scroll-margin-top: 72px; }
    blockquote {
      margin: 16px 0;
      padding: 8px 16px;
      border-left: 3px solid var(--border);
      background: color-mix(in srgb, var(--card) 70%, transparent);
      color: var(--muted);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 16px 0;
      font-size: 14px;
    }
    th, td {
      border: 1px solid var(--border);
      padding: 8px 10px;
    }
    th { background: var(--card); text-align: left; }
    .meta {
      font-size: 12px;
      color: var(--muted);
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <div>
      <h1>${safeTitle}</h1>
      <div class="meta">Markdown Render • Export from menu or buttons</div>
    </div>
    <div class="actions">
      <button class="primary" data-export="pdf">导出 PDF</button>
      <button data-export="docx">导出 DOCX</button>
      <button data-export="md">导出 MD</button>
      <button data-export="html">导出 HTML</button>
      <button data-export="txt">导出 TXT</button>
      <button data-export="png">导出 PNG</button>
      <button data-export="jpg">导出 JPG</button>
    </div>
  </div>
  <div class="content" id="md-content">${html}</div>
  <script>
    const theme = ${JSON.stringify(theme)};
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.setAttribute('data-theme', theme);
    }
    window.__MD_RENDER__ = {
      id: ${JSON.stringify(doc.id)},
      title: ${JSON.stringify(safeTitle)},
      markdown: ${JSON.stringify(doc.markdown)},
      html: ${JSON.stringify(html)},
      exportHtml: ${JSON.stringify(exportHtml)}
    };

    function requestExport(format) {
      if (window.api && typeof window.api.renderExport === 'function') {
        window.api.renderExport({
          format,
          title: window.__MD_RENDER__.title,
          markdown: window.__MD_RENDER__.markdown,
          html: window.__MD_RENDER__.html
        });
        return;
      }
      alert('导出功能不可用。');
    }

    document.querySelectorAll('[data-export]').forEach((btn) => {
      btn.addEventListener('click', () => requestExport(btn.dataset.export));
    });
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(page);
});

// 3. 创建会话
app.post('/sessions', async (req, res) => {
  try {
    const {
      headless = true,
      recordHarPath,
      recordHarContent,
      extraHTTPHeaders,
      storageState,
    } = req.body ?? {};

    const session = await sessionManager.createSession({
      headless,
      recordHarPath: typeof recordHarPath === 'string' && recordHarPath.trim().length > 0 ? recordHarPath : undefined,
      recordHarContent:
        recordHarContent === 'attach' || recordHarContent === 'omit' || recordHarContent === 'embed'
          ? recordHarContent
          : undefined,
      extraHTTPHeaders:
        extraHTTPHeaders && typeof extraHTTPHeaders === 'object' && !Array.isArray(extraHTTPHeaders)
          ? extraHTTPHeaders
          : undefined,
      storageState:
        typeof storageState === 'string' || (storageState && typeof storageState === 'object')
          ? storageState
          : undefined,
    });
    res.json({ success: true, data: { sessionId: session.id } });
  } catch (error: any) {
    const errorResponse = createErrorResponse(error);
    res.status(400).json(errorResponse);
  }
});

// [新增] 连接到现有 CDP (Electron / Chrome)
app.post('/sessions/attach', async (req, res) => {
  try {
    const { cdpEndpoint } = req.body;
    if (!cdpEndpoint) {
      const errorResponse = createErrorResponse(new Error('cdpEndpoint is required'), ErrorCode.UNKNOWN_ERROR);
      return res.status(400).json(errorResponse);
    }
    
    const session = await sessionManager.attachSession(cdpEndpoint);
    res.json({ success: true, data: { sessionId: session.id } });
  } catch (error: any) {
    console.error('Attach failed:', error);
    const errorResponse = createErrorResponse(error);
    res.status(400).json(errorResponse);
  }
});

// [新增] 重新附加到当前激活的页面
app.post('/sessions/reattach', async (req, res) => {
  try {
    const { sessionId, tabId } = req.body;
    if (!sessionId) {
      const errorResponse = createErrorResponse(new Error('sessionId is required'), ErrorCode.UNKNOWN_ERROR);
      return res.status(400).json(errorResponse);
    }
    
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      const errorResponse = createErrorResponse(new Error('Session not found'), ErrorCode.SESSION_CLOSED);
      return res.status(404).json(errorResponse);
    }
    
    const parsedTabId = typeof tabId === 'number' ? tabId : undefined;
    await session.reattach(parsedTabId);
    res.json({ success: true, data: { message: 'Reattached to active page' } });
  } catch (error: any) {
    console.error('Reattach failed:', error);
    const errorResponse = createErrorResponse(error);
    res.status(400).json(errorResponse);
  }
});

// [新增] 导出 storageState (cookies + localStorage)
app.get('/sessions/:id/storageState', async (req, res) => {
  try {
    const session = sessionManager.getSession(req.params.id);
    if (!session) {
      const errorResponse = createErrorResponse(new Error('Session not found'), ErrorCode.SESSION_CLOSED);
      return res.status(404).json(errorResponse);
    }

    const scope = req.query.scope === 'active-only' ? 'active-only' : 'visited-origins';
    const data = await session.exportStorageState(scope);
    res.json({ success: true, data });
  } catch (error: any) {
    const errorResponse = createErrorResponse(error);
    res.status(400).json(errorResponse);
  }
});

// [新增] 导入 storageState (cookies + localStorage)
app.post('/sessions/:id/storageState', async (req, res) => {
  try {
    const session = sessionManager.getSession(req.params.id);
    if (!session) {
      const errorResponse = createErrorResponse(new Error('Session not found'), ErrorCode.SESSION_CLOSED);
      return res.status(404).json(errorResponse);
    }

    const mergePolicy =
      req.body?.mergePolicy === 'replace_origin'
        ? 'replace_origin'
        : req.body?.mergePolicy === 'overwrite'
          ? 'overwrite'
          : 'merge';

    const cookies = Array.isArray(req.body?.cookies) ? req.body.cookies : [];
    const localStorage = req.body?.localStorage && typeof req.body.localStorage === 'object' ? req.body.localStorage : {};

    const applied = await session.importStorageState({ cookies, localStorage }, mergePolicy);
    res.json({ success: true, data: { ok: true, applied } });
  } catch (error: any) {
    const errorResponse = createErrorResponse(error);
    res.status(400).json(errorResponse);
  }
});

// [新增] 清空 storageState (cookies + localStorage)
app.post('/sessions/:id/storageState/clear', async (req, res) => {
  try {
    const session = sessionManager.getSession(req.params.id);
    if (!session) {
      const errorResponse = createErrorResponse(new Error('Session not found'), ErrorCode.SESSION_CLOSED);
      return res.status(404).json(errorResponse);
    }

    const cookies = req.body?.cookies !== false;
    const localStorage = req.body?.localStorage !== false;
    const result = await session.clearStorageState({ cookies, localStorage });
    res.json({ success: true, data: result });
  } catch (error: any) {
    const errorResponse = createErrorResponse(error);
    res.status(400).json(errorResponse);
  }
});

// 3. 销毁会话
app.delete('/sessions/:id', async (req, res) => {
  await sessionManager.closeSession(req.params.id);
  res.json({ success: true });
});

// 4. 通用工具调用接口
app.post('/sessions/:id/tools/:toolName', async (req, res) => {
  const { id, toolName } = req.params;
  const args = req.body;

  const session = sessionManager.getSession(id);
  if (!session) {
    const errorResponse = createErrorResponse(new Error('Session not found or expired'), ErrorCode.SESSION_CLOSED);
    return res.status(404).json(errorResponse);
  }

  // 校验工具是否存在
  const toolDef = (TOOLS as any)[toolName];
  if (!toolDef) {
    const errorResponse = createErrorResponse(new Error(`Tool '${toolName}' not found`), ErrorCode.UNKNOWN_ERROR);
    return res.status(400).json(errorResponse);
  }
  if (!isToolEnabled(toolName)) {
    const errorResponse = createErrorResponse(
      new Error(`Tool '${toolName}' is disabled in settings`),
      ErrorCode.UNKNOWN_ERROR
    );
    return res.status(403).json(errorResponse);
  }

  // 校验参数 (Zod)
  try {
    const parsedArgs = toolDef.inputSchema.parse(args);
    
    // 查找并执行 Handler
    const handler = ToolHandlers[toolName as ToolName];
    if (!handler) {
      const errorResponse = createErrorResponse(new Error(`Tool '${toolName}' not implemented on server`), ErrorCode.UNKNOWN_ERROR);
      return res.status(501).json(errorResponse);
    }

    console.log(`[${id}] Executing ${toolName}...`);
    const result = await handler(session, parsedArgs);
    
    res.json({ success: true, data: result });

  } catch (error: any) {
    console.error(`[${id}] Error executing ${toolName}:`, error);
    
    // Zod 校验错误
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: 'Invalid parameters', details: JSON.stringify(error.errors) });
    }

    // 🟢 核心修改：Playwright 错误透传
    let errorResponse: ErrorResponse = {
      success: false,
      error: error.message || 'Unknown driver error',
      details: error.details || error.stack?.split('\n').slice(0, 5).join('\n') // 只取前5行堆栈
    };

    if (error.code === 'VISION_UPSTREAM_TIMEOUT') {
      errorResponse.code = 'VISION_UPSTREAM_TIMEOUT';
      errorResponse.error = 'Visual inspection timed out while waiting for the vision model.';
    } else if (error.code === 'VISION_UPSTREAM_ERROR') {
      errorResponse.code = 'VISION_UPSTREAM_ERROR';
      errorResponse.error = 'Visual inspection failed because the upstream vision service returned an error.';
    } else if (error.message.includes('Timeout')) {
      errorResponse.code = 'TIMEOUT';
      errorResponse.error = 'Element interaction timed out (even after force retry). Page might be loading.';
    } else if (error.message.includes('Target closed')) {
      errorResponse.code = 'SESSION_CLOSED';
    }

    // 返回 400 Bad Request 而不是 500，让 Brain 知道这是业务逻辑错误
    res.status(400).json(errorResponse);
  }
});

const PORT = process.env.PORT || 13000;  // 🟢 改为高位端口
const server = app.listen(PORT, () => {
  console.log(`🚀 Alphomi Driver server running on port ${PORT}`);
});

let isShuttingDown = false;
const shutdown = async (signal?: NodeJS.Signals) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[Driver] Shutdown requested${signal ? ` via ${signal}` : ''}. Closing sessions...`);

  const timeout = setTimeout(() => {
    console.error('[Driver] Forced shutdown after timeout.');
    process.exit(0);
  }, 8000);
  timeout.unref();

  try {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  } catch (error) {
    console.error('[Driver] Server close failed:', error);
  }

  try {
    await sessionManager.closeAll();
  } catch (error) {
    console.error('[Driver] Session cleanup failed:', error);
  }

  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGQUIT', () => void shutdown('SIGQUIT'));
