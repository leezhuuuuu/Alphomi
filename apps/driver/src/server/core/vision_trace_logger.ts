import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

const CONFIG_NAMES = ['config.yaml', 'config.yml'];
const DEFAULT_TRACE_SUBDIR = path.join('apps', 'brain', 'logs', 'vllm_traces');
const FALLBACK_TRACE_DIR = path.join(process.cwd(), DEFAULT_TRACE_SUBDIR);

type VisionTraceRecord = {
  kind: 'vision_chat_completion';
  traceId: string;
  createdAt: string;
  durationMs: number;
  request: {
    method: 'POST';
    url: string;
    headers: Record<string, string>;
    body: string;
  };
  response?: {
    status?: number;
    headers?: Record<string, unknown>;
    body?: string;
  };
  outcome: {
    status: 'success' | 'error';
    model?: string;
    candidateCount?: number;
    errorCode?: string;
    errorMessage?: string;
  };
  context?: {
    targetName?: string;
    question?: string;
    contextHint?: string;
    includeState?: boolean;
    answerMode?: string;
    captureScope?: string;
    imageRefs?: string[];
    timeoutMs: number;
    env: Record<string, string>;
  };
  parsed?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    code?: string;
    stack?: string;
  };
};

const findRepoRoot = (startDir: string): string | null => {
  let current = startDir;
  while (true) {
    for (const name of CONFIG_NAMES) {
      const candidate = path.join(current, name);
      try {
        // eslint-disable-next-line no-sync
        require('fs').accessSync(candidate);
        return current;
      } catch {
        // noop
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

const resolveTraceDir = (): string => {
  const configured = process.env.VISION_TRACES_DIR?.trim();
  const repoRoot = findRepoRoot(process.cwd());
  if (configured) {
    if (path.isAbsolute(configured)) {
      return configured;
    }
    return path.join(repoRoot || process.cwd(), configured);
  }
  if (repoRoot) {
    return path.join(repoRoot, DEFAULT_TRACE_SUBDIR);
  }
  return FALLBACK_TRACE_DIR;
};

const toJson = (value: unknown): string => {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

export const createVisionTraceId = (): string => randomUUID();

export const saveVisionTrace = async (record: VisionTraceRecord): Promise<string | null> => {
  try {
    const dir = resolveTraceDir();
    await fs.mkdir(dir, { recursive: true });

    const safeTimestamp = record.createdAt.replace(/[:.]/g, '-');
    const filename = `vllm_trace_${safeTimestamp}_${record.traceId}.json`;
    const filePath = path.join(dir, filename);
    await fs.writeFile(filePath, `${toJson(record)}\n`, 'utf8');
    return filePath;
  } catch (error) {
    console.error('[vision-trace] failed to persist VLM trace', error);
    return null;
  }
};
