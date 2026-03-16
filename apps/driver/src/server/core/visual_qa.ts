import axios from 'axios';
import { createVisionTraceId, saveVisionTrace } from './vision_trace_logger';

const DEFAULT_VISION_TIMEOUT_MS = 60000;
const DEFAULT_VISION_TEMPERATURE = 0;
const DEFAULT_VISION_TOP_P = 0.1;
const DEFAULT_VISION_IMAGE_DETAIL = 'high';
const DEFAULT_VISION_ENABLE_THINK = false;

type VisualQaImage = {
  url: string;
  detail?: string;
};

type VisualQaArgs = {
  question: string;
  answerMode: 'text' | 'json';
  images: VisualQaImage[];
  contextHint?: string;
  captureScope?: 'viewport' | 'full_page';
  imageRefs?: string[];
};

type VisualQaResult = {
  answer: unknown;
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

const REPORT_TOOL_NAME = 'report_visual_answer';

const VISION_QA_SYSTEM_PROMPT_BASE = `You are a webpage visual question answering engine.

Answer the user's question using only the provided image inputs.

Rules:
- Ground every answer strictly in visible evidence from the images.
- Do not infer hidden DOM state, metadata, or information outside the images.
- If the answer is not visually clear, say so explicitly.
- You must call the function report_visual_answer.
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

const parseAnswerText = (value: unknown): string => {
  if (typeof value !== 'string') {
    throw new Error('MODEL_PROTOCOL_ERROR: visual answer is missing');
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    throw new Error('MODEL_PROTOCOL_ERROR: visual answer is empty');
  }
  return normalized.slice(0, 4000);
};

const parseAnswerJson = (value: unknown): unknown => {
  if (typeof value !== 'string') {
    throw new Error('MODEL_PROTOCOL_ERROR: visual JSON answer is missing');
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new Error('MODEL_PROTOCOL_ERROR: visual JSON answer is empty');
  }

  try {
    return JSON.parse(normalized);
  } catch {
    throw new Error('MODEL_PROTOCOL_ERROR: visual JSON answer is not valid JSON');
  }
};

const buildUserPrompt = ({
  question,
  answerMode,
  contextHint,
  captureScope,
  imageRefs,
}: {
  question: string;
  answerMode: 'text' | 'json';
  contextHint?: string;
  captureScope?: 'viewport' | 'full_page';
  imageRefs?: string[];
}): string =>
  [
    `Question: ${question}`,
    contextHint ? `Context hint: ${contextHint}` : '',
    captureScope ? `Current capture scope: ${captureScope}` : '',
    imageRefs && imageRefs.length > 0 ? `Referenced images: ${imageRefs.join(', ')}` : '',
    answerMode === 'json'
      ? 'Return the final answer as a valid JSON string in the answer field. The string itself must be parseable JSON.'
      : 'Return the final answer as concise plain text in the answer field.',
    'Call report_visual_answer with the final answer only.',
  ]
    .filter((line) => line.length > 0)
    .join('\n');

export const askVisualQuestion = async ({
  question,
  answerMode,
  images,
  contextHint,
  captureScope,
  imageRefs,
}: VisualQaArgs): Promise<VisualQaResult> => {
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
  if (!Array.isArray(images) || images.length === 0) {
    throw new Error('INVALID_VISUAL_QA_REQUEST: at least one image is required');
  }

  const endpoint = resolveVisionEndpoint(baseUrl);
  const timeout = parseNumberEnv(process.env.VISION_TIMEOUT_MS, DEFAULT_VISION_TIMEOUT_MS);
  const maxTokens = parseOptionalPositiveIntEnv(process.env.VISION_MAX_TOKENS);
  const temperature = parseNumberEnv(process.env.VISION_TEMPERATURE, DEFAULT_VISION_TEMPERATURE);
  const topP = parseNumberEnv(process.env.VISION_TOP_P, DEFAULT_VISION_TOP_P);
  const defaultDetail = process.env.VISION_IMAGE_DETAIL || DEFAULT_VISION_IMAGE_DETAIL;
  const enableThink = parseBooleanEnv(process.env.VISION_ENABLE_THINK, DEFAULT_VISION_ENABLE_THINK);
  const systemPrompt = enableThink ? VISION_QA_SYSTEM_PROMPT_BASE : `${VISION_QA_SYSTEM_PROMPT_BASE}\n/no_think`;
  const traceId = createVisionTraceId();
  const requestStartedAt = Date.now();

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
          ...images.map((image) => ({
            type: 'image_url',
            image_url: {
              url: image.url,
              detail: image.detail || defaultDetail,
            },
          })),
          {
            type: 'text',
            text: buildUserPrompt({ question, answerMode, contextHint, captureScope, imageRefs }),
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
          description:
            answerMode === 'json'
              ? 'Return the answer as a valid JSON string.'
              : 'Return the answer as concise plain text.',
          parameters: {
            type: 'object',
            properties: {
              answer: { type: 'string' },
            },
            required: ['answer'],
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

    const answer =
      answerMode === 'json'
        ? parseAnswerJson(payload.answer)
        : parseAnswerText(payload.answer);

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
      },
      context: {
        question,
        contextHint,
        answerMode,
        captureScope,
        imageRefs,
        timeoutMs: timeout,
        env: {
          HTTP_PROXY: process.env.HTTP_PROXY || '',
          HTTPS_PROXY: process.env.HTTPS_PROXY || '',
          ALL_PROXY: process.env.ALL_PROXY || '',
          NO_PROXY: process.env.NO_PROXY || '',
          VISION_MODEL: model,
          VISION_ENABLE_THINK: String(enableThink),
          VISION_IMAGE_DETAIL: defaultDetail,
          VISION_MAX_TOKENS: process.env.VISION_MAX_TOKENS || '',
        },
      },
      parsed: {
        message,
        payload,
      },
    });

    return {
      answer,
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
      response: rawResponseBody || responseStatus || responseHeaders
        ? {
            status: responseStatus,
            headers: responseHeaders,
            body: rawResponseBody,
          }
        : undefined,
      outcome: {
        status: 'error',
        model,
        errorCode: axiosError?.code,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      context: {
        question,
        contextHint,
        answerMode,
        captureScope,
        imageRefs,
        timeoutMs: timeout,
        env: {
          HTTP_PROXY: process.env.HTTP_PROXY || '',
          HTTPS_PROXY: process.env.HTTPS_PROXY || '',
          ALL_PROXY: process.env.ALL_PROXY || '',
          NO_PROXY: process.env.NO_PROXY || '',
          VISION_MODEL: model,
          VISION_ENABLE_THINK: String(enableThink),
          VISION_IMAGE_DETAIL: defaultDetail,
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
