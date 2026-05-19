export enum LogLevel {
  TRACE = 0,
  DEBUG = 1,
  INFO = 2,
  WARN = 3,
  ERROR = 4,
}

/**
 * 敏感字段名称列表,这些字段的值应该被脱敏
 */
const SENSITIVE_FIELDS = [
  'appSecret',
  'app_secret',
  'secret',
  'accessToken',
  'access_token',
  'token',
  'encodingAesKey',
  'encoding_aes_key',
  'password',
  'apiKey',
  'api_key',
];

/**
 * 判断字段名是否属于敏感信息。
 *
 * 日志里既要能排查问题，又不能泄露密钥。这里按字段名做第一层判断：
 * 只有明确命中敏感字段时才整体隐藏，避免把 fileName、format、errmsg
 * 这类排障信息也误伤成 ***。
 */
function isSensitiveFieldName(key: string): boolean {
  const lowerKey = key.toLowerCase();
  return SENSITIVE_FIELDS.some(field => lowerKey.includes(field.toLowerCase()));
}

/**
 * 对敏感值做稳定脱敏。
 *
 * 长值保留头尾便于确认“是不是同一个值”，短值直接隐藏，避免在日志中泄露凭证。
 */
function maskSensitiveValue(value: unknown): unknown {
  if (typeof value !== 'string') {
    return sanitizeValue(value);
  }

  if (value.length > 16) {
    return `${value.substring(0, 8)}...${value.substring(value.length - 4)}`;
  }

  return '***';
}

/**
 * 清理字符串中可能混入的敏感片段。
 *
 * 非敏感字段的字符串需要保留可读性，但 URL、Authorization 或 JSON 字符串中
 * 仍可能带 access_token/app_secret，所以这里做第二层兜底脱敏。
 */
function sanitizeString(value: string): string {
  return value
    .replace(/(access_token=)[^&\s]+/gi, '$1***')
    .replace(/([?&]token=)[^&\s]+/gi, '$1***')
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, '$1***')
    .replace(/("(?:appSecret|app_secret|secret|accessToken|access_token|token|encodingAesKey|encoding_aes_key|password|apiKey|api_key)"\s*:\s*")[^"]+"/gi, '$1***"');
}

/**
 * Error 默认没有可枚举字段，直接 Object.entries 会打印成 {}。
 * 这里提取安全且有排障价值的字段，避免线上日志只剩一个空对象。
 */
function sanitizeError(error: Error): Record<string, unknown> {
  const extraFields: Record<string, unknown> = {};
  const errorLike = error as Error & Record<string, unknown>;

  for (const key of ['code', 'errno', 'syscall', 'status', 'statusCode', 'errcode', 'errmsg']) {
    if (errorLike[key] !== undefined) {
      extraFields[key] = sanitizeValue(errorLike[key]);
    }
  }

  return {
    name: error.name,
    message: sanitizeString(error.message),
    stack: error.stack ? sanitizeString(error.stack) : undefined,
    ...extraFields,
  };
}

/**
 * 脱敏处理 - 只隐藏敏感字段和字符串中的敏感片段
 */
function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeString(value);
  }

  if (value instanceof Error) {
    return sanitizeError(value);
  }

  if (typeof value === 'object' && value !== null) {
    if (Array.isArray(value)) {
      return value.map(sanitizeValue);
    }

    const sanitized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      sanitized[key] = isSensitiveFieldName(key) ? maskSensitiveValue(val) : sanitizeValue(val);
    }
    return sanitized;
  }

  return value;
}

class Logger {
  private level: LogLevel = LogLevel.INFO;

  setLevel(level: LogLevel) {
    this.level = level;
  }

  private log(level: LogLevel, message: string, ...args: unknown[]) {
    if (level >= this.level) {
      const timestamp = new Date().toISOString();
      const levelName = LogLevel[level];

      // 脱敏所有参数
      const sanitizedArgs = args.map(arg => sanitizeValue(arg));

      // MCP stdio 传输要求 stdout 只承载 JSON-RPC 协议消息。
      // 普通日志必须写入 stderr，否则严格客户端会把日志当协议内容解析并导致工具发现失败。
      console.error(`[${timestamp}] [${levelName}] ${message}`, ...sanitizedArgs);
    }
  }

  trace(message: string, ...args: unknown[]) {
    this.log(LogLevel.TRACE, message, ...args);
  }

  debug(message: string, ...args: unknown[]) {
    this.log(LogLevel.DEBUG, message, ...args);
  }

  info(message: string, ...args: unknown[]) {
    this.log(LogLevel.INFO, message, ...args);
  }

  warn(message: string, ...args: unknown[]) {
    this.log(LogLevel.WARN, message, ...args);
  }

  error(message: string, ...args: unknown[]) {
    this.log(LogLevel.ERROR, message, ...args);
  }
}

export const logger = new Logger();
