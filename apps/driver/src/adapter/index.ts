#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
  Tool
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
// 注意：移除了对 '../common/tools' 的引用，实现了真正解耦！
import { ToolExecutionResult } from '../types/protocol';
import { loadConfigFromYaml } from '../common/config';

loadConfigFromYaml('driver');

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:13000';  // 🟢 改为高位端口
// 默认为 true (无头)，如果环境变量设为 'false' 则为有头
const IS_HEADLESS = process.env.HEADLESS !== 'false';

async function main() {
  let sessionId: string | null = null;

  // 1. 连接 REST Server
  try {
    // 尝试连接，如果失败直接退出（Stdio 模式下必须快速失败）
    await axios.get(`${API_BASE_URL}/health`);
    
    // 创建 Session
    console.error(`[Adapter] Requesting session with headless=${IS_HEADLESS}...`);
    const res = await axios.post(`${API_BASE_URL}/sessions`, {
        headless: IS_HEADLESS
    });
    sessionId = res.data.data.sessionId;
    // 注意：不要用 console.log，因为 stdio 传输会被污染。用 console.error 打印日志。
    console.error(`[Adapter] Connected to session: ${sessionId}`);
  } catch (e: any) {
    console.error(`[Adapter] Failed to connect to REST server: ${e.message}`);
    process.exit(1);
  }

  const server = new Server(
    { name: 'playwright-rest-adapter', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // 2. ListTools：动态从 REST Server 获取
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const response = await axios.get(`${API_BASE_URL}/tools`);
      if (!response.data.success) {
        throw new Error('Failed to fetch tools from server');
      }
      // 直接透传 Server 返回的 Schema
      return { tools: response.data.data.tools as Tool[] };
    } catch (error: any) {
      console.error('[Adapter] ListTools failed:', error.message);
      throw new McpError(ErrorCode.InternalError, 'Failed to list tools');
    }
  });

  // 3. CallTool：核心转换逻辑
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (!sessionId) throw new McpError(ErrorCode.InternalError, 'Session lost');

    try {
      const response = await axios.post(
        `${API_BASE_URL}/sessions/${sessionId}/tools/${name}`,
        args
      );

      const apiData: ToolExecutionResult = response.data.data;
      const content: any[] = [];

      // A. 文本结果
      if (apiData.result) {
        content.push({ type: 'text', text: apiData.result });
      }

      // B. 页面快照 (这是官方 MCP 的标志性输出)
      if (apiData.snapshot) {
        content.push({
            type: 'text',
            text: `\nPage Snapshot:\n\`\`\`yaml\n${apiData.snapshot}\n\`\`\``
        });
      }

      // C. 截图 (二进制转 MCP Image)
      if (apiData.base64) {
        content.push({
          type: 'image',
          data: apiData.base64,
          mimeType: 'image/png' // 假设默认 png，如果支持 jpeg 需要从 API 返回 mimeType
        });
      }

      return { content, isError: false };

    } catch (error: any) {
      // 错误处理
      const errorMsg = error.response?.data?.error || error.message;
      console.error(`[Adapter] Tool execution failed: ${errorMsg}`);
      return {
        content: [{ type: 'text', text: `Error: ${errorMsg}` }],
        isError: true
      };
    }
  });

  // 4. 启动
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 5. 清理
  const cleanup = async () => {
    if (sessionId) {
        try { await axios.delete(`${API_BASE_URL}/sessions/${sessionId}`); }
        catch {}
    }
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main();
