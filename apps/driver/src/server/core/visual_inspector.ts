import axios from 'axios';
import {
  type VisualCandidate,
} from '../../types/protocol';
import { createVisionTraceId, saveVisionTrace } from './vision_trace_logger';

const NORMALIZED_MAX = 1000;
const DEFAULT_VISION_TIMEOUT_MS = 60000;
const DEFAULT_VISION_TEMPERATURE = 0;
const DEFAULT_VISION_TOP_P = 0.1;
const DEFAULT_VISION_IMAGE_DETAIL = 'high';
const DEFAULT_VISION_ENABLE_THINK = false;

type VisualInspectorArgs = {
  screenshotBase64: string;
  targetName: string;
  includeState: boolean;
  contextHint?: string;
};

type VisualInspectorResult = {
  candidates: VisualCandidate[];
  model?: string;
  tracePath?: string | null;
};

type RawToolCall = {
  function?: {
    name?: string;
    arguments?: string;
  };
};

type RawVisionResponse = {
  model?: string;
  choices?: Array<{
    message?: {
      content?: unknown;
      tool_calls?: RawToolCall[];
    };
  }>;
  [key: string]: unknown;
};

type DriverToolError = Error & {
  code?: string;
  details?: string;
};

const REPORT_TOOL_NAME = 'report_visual_candidates';

const VISION_SYSTEM_PROMPT_BASE = `You are a webpage UI visual inspection engine.

Return every visible candidate that matches the requested UI target in the current viewport screenshot.

Coordinate rules:
- Use normalized viewport coordinates in the integer range [0, 1000].
- The top-left corner is (0, 0).
- The bottom-right corner is (1000, 1000).
- Never return physical pixels.

State rules:
- Only if the request explicitly says includeState=true, include a visualState string for each candidate.
- visualState must be a short description of visually observable state only, such as "looks selected/highlighted", "appears unchecked", "menu appears open", "disabled/greyed out", "loading spinner visible", or "state not visually clear".
- Do not infer hidden DOM state, accessibility attributes, or anything not visually evident.
- If includeState=false, do not include visualState.

Output rules:
- You must call the function report_visual_candidates.
- Return every plausible matching candidate, not only one.
- Sort is handled downstream, so focus on accurate candidates.
- Each candidate must include bbox, visualStyle, anchorText, and spatialContext.
- anchorText should contain nearby labels or text that help distinguish repeated elements.
- If nothing matches, return an empty candidates array.
- Do not output natural language outside the tool call.`;

const parseNumberEnv = (value: string | undefined, fallback: number): number => {
  const parsed = value ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseOptionalPositiveIntEnv = (value: string | undefined): number | undefined => {
  const parsed = value ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return undefined;
  const rounded = Math.round(parsed);
  return rounded > 0 ? rounded : undefined;
};

const parseBooleanEnv = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

const resolveVisionEndpoint = (rawBaseUrl: string): string => {
  const base = rawBaseUrl.trim().replace(/\/+$/, '');
  const lowered = base.toLowerCase();
  if (lowered.endsWith('/chat/completions')) {
    return base;
  }
  if (lowered.endsWith('/v1')) {
    return `${base}/chat/completions`;
  }
  return `${base}/chat/completions`;
};

const clampNormalizedInt = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.round(parsed);
  if (rounded < 0) return 0;
  if (rounded > NORMALIZED_MAX) return NORMALIZED_MAX;
  return rounded;
};

const parseAnchorText = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0)
      .slice(0, 8);
  }
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }
  return [];
};

const parseVisualStateDescription = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) return undefined;
  return normalized.slice(0, 240);
};

const parseToolArguments = (toolCalls: RawToolCall[] | undefined): Record<string, unknown> | null => {
  for (const call of toolCalls || []) {
    if (call?.function?.name !== REPORT_TOOL_NAME) continue;
    const rawArgs = call.function.arguments;
    if (!rawArgs || typeof rawArgs !== 'string') continue;
    try {
      const parsed = JSON.parse(rawArgs);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
};

const parseContentJson = (content: unknown): Record<string, unknown> | null => {
  if (typeof content !== 'string' || !content.trim()) return null;
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

const parseResponseJson = (rawBody: string): RawVisionResponse => {
  const parsed = JSON.parse(rawBody);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('MODEL_PROTOCOL_ERROR: vision response is not a JSON object');
  }
  return parsed as RawVisionResponse;
};

const normalizeCandidates = (rawCandidates: unknown, includeState: boolean): VisualCandidate[] => {
  if (!Array.isArray(rawCandidates)) return [];

  const normalized: VisualCandidate[] = [];
  for (const item of rawCandidates) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const bboxRaw = raw.bbox && typeof raw.bbox === 'object' ? raw.bbox as Record<string, unknown> : null;
    if (!bboxRaw) continue;

    const x1 = clampNormalizedInt(bboxRaw.x1);
    const y1 = clampNormalizedInt(bboxRaw.y1);
    const x2 = clampNormalizedInt(bboxRaw.x2);
    const y2 = clampNormalizedInt(bboxRaw.y2);
    if (x1 === null || y1 === null || x2 === null || y2 === null) continue;
    if (x2 <= x1 || y2 <= y1) continue;

    const visualStyle = typeof raw.visualStyle === 'string'
      ? raw.visualStyle.trim()
      : typeof raw.visual_style === 'string'
        ? raw.visual_style.trim()
        : '';
    const spatialContext = typeof raw.spatialContext === 'string'
      ? raw.spatialContext.trim()
      : typeof raw.spatial_context === 'string'
        ? raw.spatial_context.trim()
        : '';

    const visibleText = typeof raw.visibleText === 'string'
      ? raw.visibleText.trim()
      : typeof raw.visible_text === 'string'
        ? raw.visible_text.trim()
        : undefined;

    const elementRole = typeof raw.elementRole === 'string'
      ? raw.elementRole.trim()
      : typeof raw.element_role === 'string'
        ? raw.element_role.trim()
        : undefined;

    const confidenceRaw = typeof raw.confidence === 'number' ? raw.confidence : Number(raw.confidence);
    const confidence = Number.isFinite(confidenceRaw)
      ? Math.max(0, Math.min(1, confidenceRaw))
      : undefined;
    const visualState = includeState
      ? parseVisualStateDescription(raw.visualState ?? raw.visual_state)
      : undefined;

    normalized.push({
      candidateId: 0,
      bbox: { x1, y1, x2, y2 },
      visibleText: visibleText || undefined,
      elementRole: elementRole || undefined,
      visualStyle: visualStyle || 'unknown',
      anchorText: parseAnchorText(raw.anchorText ?? raw.anchor_text),
      spatialContext: spatialContext || 'unknown',
      ...(visualState ? { visualState } : {}),
      confidence,
    });
  }

  normalized.sort((a, b) => {
    if (a.bbox.y1 !== b.bbox.y1) return a.bbox.y1 - b.bbox.y1;
    return a.bbox.x1 - b.bbox.x1;
  });

  return normalized.map((candidate, index) => ({
    ...candidate,
    candidateId: index + 1,
  }));
};

export const inspectVisualCandidates = async ({
  screenshotBase64,
  targetName,
  includeState,
  contextHint,
}: VisualInspectorArgs): Promise<VisualInspectorResult> => {
  const apiKey = process.env.VISION_API_KEY || '';
  const baseUrl = process.env.VISION_BASE_URL || '';
  const model = process.env.VISION_MODEL || '';

  if (!apiKey) {
    throw new Error('VISION_API_KEY is not configured');
  }
  if (!baseUrl) {
    throw new Error('VISION_BASE_URL is not configured');
  }
  if (!model) {
    throw new Error('VISION_MODEL is not configured');
  }

  const endpoint = resolveVisionEndpoint(baseUrl);
  const timeout = parseNumberEnv(process.env.VISION_TIMEOUT_MS, DEFAULT_VISION_TIMEOUT_MS);
  const maxTokens = parseOptionalPositiveIntEnv(process.env.VISION_MAX_TOKENS);
  const temperature = parseNumberEnv(process.env.VISION_TEMPERATURE, DEFAULT_VISION_TEMPERATURE);
  const topP = parseNumberEnv(process.env.VISION_TOP_P, DEFAULT_VISION_TOP_P);
  const detail = process.env.VISION_IMAGE_DETAIL || DEFAULT_VISION_IMAGE_DETAIL;
  const enableThink = parseBooleanEnv(process.env.VISION_ENABLE_THINK, DEFAULT_VISION_ENABLE_THINK);
  const systemPrompt = enableThink ? VISION_SYSTEM_PROMPT_BASE : `${VISION_SYSTEM_PROMPT_BASE}\n/no_think`;
  const traceId = createVisionTraceId();
  const requestStartedAt = Date.now();

  const prompt = [
    `Find all visible candidates that match: "${targetName}".`,
    contextHint ? `Extra hint: ${contextHint}` : '',
    `includeState=${includeState}.`,
    includeState
      ? 'Add a short visualState string for each candidate describing only visually observable state. If the state is unclear, say so explicitly.'
      : 'Do not include any visualState field.',
    'Call report_visual_candidates with the candidates array only.',
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  const candidateProperties: Record<string, unknown> = {
    bbox: {
      type: 'object',
      properties: {
        x1: { type: 'integer' },
        y1: { type: 'integer' },
        x2: { type: 'integer' },
        y2: { type: 'integer' },
      },
      required: ['x1', 'y1', 'x2', 'y2'],
    },
    visibleText: { type: 'string' },
    elementRole: { type: 'string' },
    visualStyle: { type: 'string' },
    anchorText: {
      type: 'array',
      items: { type: 'string' },
    },
    spatialContext: { type: 'string' },
    confidence: { type: 'number' },
  };
  const candidateRequired = ['bbox', 'visualStyle', 'anchorText', 'spatialContext'];
  if (includeState) {
    candidateProperties.visualState = { type: 'string' };
    candidateRequired.push('visualState');
  }

  const requestPayload = {
    model,
    stream: false,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    temperature,
    top_p: topP,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${screenshotBase64}`,
              detail,
            },
          },
          {
            type: 'text',
            text: prompt,
          },
        ],
      },
    ],
    tool_choice: {
      type: 'function',
      function: { name: REPORT_TOOL_NAME },
    },
    tools: [
      {
        type: 'function',
        function: {
          name: REPORT_TOOL_NAME,
          description: 'Return all matching visual candidates in normalized [0,1000] viewport coordinates, optionally including a short visualState description when requested.',
          parameters: {
            type: 'object',
            properties: {
              candidates: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    ...candidateProperties,
                  },
                  required: candidateRequired,
                },
              },
            },
            required: ['candidates'],
          },
        },
      },
    ],
  };

  const requestHeaders = {
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  };
  const requestBody = JSON.stringify(requestPayload);

  let rawResponseBody = '';
  let responseStatus: number | undefined;
  let responseHeaders: Record<string, unknown> | undefined;
  let tracePath: string | null = null;
  let parsedResponse: RawVisionResponse | undefined;

  try {
    const response = await axios.post(endpoint, requestBody, {
      timeout,
      transformResponse: [(data) => data],
      headers: requestHeaders,
    });

    rawResponseBody = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    responseStatus = response.status;
    responseHeaders = response.headers as Record<string, unknown>;
    parsedResponse = parseResponseJson(rawResponseBody);

    const message = parsedResponse.choices?.[0]?.message || {};
    const payload = parseToolArguments(message.tool_calls as RawToolCall[] | undefined) || parseContentJson(message.content);
    if (!payload) {
      throw new Error('MODEL_PROTOCOL_ERROR: vision model did not return a valid tool call payload');
    }

    const candidates = normalizeCandidates(payload.candidates, includeState);
    tracePath = await saveVisionTrace({
      kind: 'vision_chat_completion',
      traceId,
      createdAt: new Date(requestStartedAt).toISOString(),
      durationMs: Date.now() - requestStartedAt,
      request: {
        method: 'POST',
        url: endpoint,
        headers: requestHeaders,
        body: requestBody,
      },
      response: {
        status: responseStatus,
        headers: responseHeaders,
        body: rawResponseBody,
      },
      outcome: {
        status: 'success',
        model: typeof parsedResponse.model === 'string' ? parsedResponse.model : model,
        candidateCount: candidates.length,
      },
      context: {
        targetName,
        contextHint,
        includeState,
        timeoutMs: timeout,
        env: {
          HTTP_PROXY: process.env.HTTP_PROXY || '',
          HTTPS_PROXY: process.env.HTTPS_PROXY || '',
          ALL_PROXY: process.env.ALL_PROXY || '',
          NO_PROXY: process.env.NO_PROXY || '',
          VISION_MODEL: model,
          VISION_ENABLE_THINK: String(enableThink),
          VISION_IMAGE_DETAIL: detail,
          VISION_MAX_TOKENS: process.env.VISION_MAX_TOKENS || '',
        },
      },
      parsed: {
        message,
        payload,
      },
    });

    return {
      candidates,
      model: typeof parsedResponse.model === 'string' ? parsedResponse.model : undefined,
      tracePath,
    };
  } catch (error) {
    const axiosError = axios.isAxiosError(error) ? error : null;
    const errorResponseData = axiosError?.response?.data;
    if (!rawResponseBody && typeof errorResponseData === 'string') {
      rawResponseBody = errorResponseData;
    } else if (!rawResponseBody && errorResponseData !== undefined) {
      rawResponseBody = JSON.stringify(errorResponseData);
    }
    if (!responseStatus && axiosError?.response?.status) {
      responseStatus = axiosError.response.status;
    }
    if (!responseHeaders && axiosError?.response?.headers) {
      responseHeaders = axiosError.response.headers as Record<string, unknown>;
    }

    tracePath = await saveVisionTrace({
      kind: 'vision_chat_completion',
      traceId,
      createdAt: new Date(requestStartedAt).toISOString(),
      durationMs: Date.now() - requestStartedAt,
      request: {
        method: 'POST',
        url: endpoint,
        headers: requestHeaders,
        body: requestBody,
      },
      response: rawResponseBody || responseStatus || responseHeaders ? {
        status: responseStatus,
        headers: responseHeaders,
        body: rawResponseBody,
      } : undefined,
      outcome: {
        status: 'error',
        model,
        errorCode: axiosError?.code,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      context: {
        targetName,
        contextHint,
        includeState,
        timeoutMs: timeout,
        env: {
          HTTP_PROXY: process.env.HTTP_PROXY || '',
          HTTPS_PROXY: process.env.HTTPS_PROXY || '',
          ALL_PROXY: process.env.ALL_PROXY || '',
          NO_PROXY: process.env.NO_PROXY || '',
          VISION_MODEL: model,
          VISION_ENABLE_THINK: String(enableThink),
          VISION_IMAGE_DETAIL: detail,
          VISION_MAX_TOKENS: process.env.VISION_MAX_TOKENS || '',
        },
      },
      parsed: parsedResponse ? { response: parsedResponse } : undefined,
      error: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
        code: axiosError?.code,
        stack: error instanceof Error ? error.stack : undefined,
      },
    });
    const details = [
      tracePath ? `Trace: ${tracePath}` : '',
      error instanceof Error && error.stack ? error.stack : '',
    ]
      .filter((item) => item.length > 0)
      .join('\n');

    if (axiosError?.code === 'ECONNABORTED') {
      const wrapped = new Error(`Vision model timed out after ${timeout}ms.`) as DriverToolError;
      wrapped.code = 'VISION_UPSTREAM_TIMEOUT';
      wrapped.details = details;
      throw wrapped;
    }

    if (axiosError?.response) {
      const wrapped = new Error(`Vision model request failed with status ${axiosError.response.status}.`) as DriverToolError;
      wrapped.code = 'VISION_UPSTREAM_ERROR';
      wrapped.details = details;
      throw wrapped;
    }

    if (error instanceof Error) {
      (error as DriverToolError).details = details;
      throw error;
    }

    const wrapped = new Error(String(error)) as DriverToolError;
    wrapped.details = details;
    throw wrapped;
  }
};
