/**
 * 标准错误响应结构
 */
export interface ErrorResponse {
  success: false;
  error: string;    // 给人类/日志看的简短描述
  details?: string; // 给 AI 看的详细技术细节 (Playwright 原始报错)
  code?: string;    // 错误类型标记 (如 'ELEMENT_NOT_FOUND', 'STRICT_MODE_VIOLATION')
}

/**
 * 错误代码枚举
 */
export enum ErrorCode {
  AMBIGUOUS_SELECTOR = 'AMBIGUOUS_SELECTOR',
  TIMEOUT = 'TIMEOUT',
  VISION_UPSTREAM_TIMEOUT = 'VISION_UPSTREAM_TIMEOUT',
  VISION_UPSTREAM_ERROR = 'VISION_UPSTREAM_ERROR',
  SESSION_CLOSED = 'SESSION_CLOSED',
  ELEMENT_NOT_FOUND = 'ELEMENT_NOT_FOUND',
  NAVIGATION_ERROR = 'NAVIGATION_ERROR',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR'
}

/**
 * 根据错误消息识别错误类型
 */
export function identifyErrorType(message: string): ErrorCode {
  const msg = message.toLowerCase();
  
  if (msg.includes('strict mode violation')) {
    return ErrorCode.AMBIGUOUS_SELECTOR;
  } else if (msg.includes('timeout')) {
    return ErrorCode.TIMEOUT;
  } else if (msg.includes('target closed') || msg.includes('session not found')) {
    return ErrorCode.SESSION_CLOSED;
  } else if (msg.includes('not found') || msg.includes('selector')) {
    return ErrorCode.ELEMENT_NOT_FOUND;
  } else if (msg.includes('navigation') || msg.includes('net::err_')) {
    return ErrorCode.NAVIGATION_ERROR;
  }
  
  return ErrorCode.UNKNOWN_ERROR;
}

/**
 * 创建标准错误响应
 */
export function createErrorResponse(error: any, code?: ErrorCode): ErrorResponse {
  const message = error?.message || 'Unknown error';
  const errorType = code || identifyErrorType(message);
  
  let errorMessage = message;
  
  // 根据错误类型提供更友好的错误描述
  switch (errorType) {
    case ErrorCode.AMBIGUOUS_SELECTOR:
      errorMessage = 'Found multiple elements matching the description. Please provide a more specific ref or description.';
      break;
    case ErrorCode.TIMEOUT:
      errorMessage = 'Action timed out. The element might not be visible or the page is too slow.';
      break;
    case ErrorCode.VISION_UPSTREAM_TIMEOUT:
      errorMessage = 'Visual inspection timed out while waiting for the vision model.';
      break;
    case ErrorCode.VISION_UPSTREAM_ERROR:
      errorMessage = 'Visual inspection failed because the upstream vision service returned an error.';
      break;
    case ErrorCode.SESSION_CLOSED:
      errorMessage = 'Browser session has been closed or is no longer accessible.';
      break;
    case ErrorCode.ELEMENT_NOT_FOUND:
      errorMessage = 'Could not find the specified element on the page.';
      break;
    case ErrorCode.NAVIGATION_ERROR:
      errorMessage = 'Failed to navigate to the specified URL.';
      break;
  }
  
  return {
    success: false,
    error: errorMessage,
    details: error?.stack || message,
    code: errorType
  };
}
