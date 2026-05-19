import crypto from 'crypto';
import { WECHAT_UPLOADIMG_MAX_SIZE_BYTES } from './image-upload.js';

export const IMAGE_UPLOAD_TICKET_QUERY_KEY = 'upload_token';
export const IMAGE_UPLOAD_TICKET_HEADER = 'x-mcp-upload-token';
export const DEFAULT_IMAGE_UPLOAD_TICKET_TTL_SECONDS = 5 * 60;
const MIN_IMAGE_UPLOAD_TICKET_TTL_SECONDS = 30;
const MAX_IMAGE_UPLOAD_TICKET_TTL_SECONDS = 15 * 60;

export interface ImageUploadTicket {
  token: string;
  createdAt: number;
  expiresAt: number;
  maxBytes: number;
}

export type ConsumeImageUploadTicketResult =
  | { ok: true; ticket: ImageUploadTicket }
  | { ok: false; reason: 'missing_token' | 'not_found' | 'expired' };

const imageUploadTickets = new Map<string, ImageUploadTicket>();

/**
 * 返回公网可访问的 MCP SSE 服务根地址。
 *
 * prepare 工具运行在 MCP 调用链路里，拿不到当前 HTTP 请求的 Host，
 * 因此必须通过环境变量显式告诉服务端外部访问地址。这样可避免 AI
 * 自己猜域名，也避免把长期 MCP_AUTH_TOKEN 暴露给模型。
 */
export function getMcpPublicBaseUrl(): string | undefined {
  const rawBaseUrl = process.env.MCP_PUBLIC_BASE_URL?.trim();
  if (!rawBaseUrl) {
    return undefined;
  }

  return rawBaseUrl.replace(/\/+$/, '');
}

/**
 * 返回可选的 curl DNS 覆盖提示。
 *
 * 部分沙箱环境无法解析用户域名，但又不适合把 HTTPS URL 改成 IP：
 * 直接使用 https://IP 会导致 TLS 证书域名不匹配。此时 curl 可以使用
 * --resolve host:port:ip，在保留 HTTPS 域名校验的同时绕过 DNS。
 */
export function getMcpUploadCurlResolve(): string | undefined {
  const rawResolve = process.env.MCP_UPLOAD_CURL_RESOLVE?.trim();
  return rawResolve || undefined;
}

/**
 * 读取并限制临时上传票据有效期。
 *
 * 默认 5 分钟，允许通过 MCP_IMAGE_UPLOAD_TICKET_TTL_SECONDS 调整；
 * 上下限用于避免误配置成过短导致不可用，或过长导致上传 URL 风险扩大。
 */
export function getImageUploadTicketTtlSeconds(): number {
  const rawTtl = process.env.MCP_IMAGE_UPLOAD_TICKET_TTL_SECONDS;
  const parsedTtl = rawTtl ? Number.parseInt(rawTtl, 10) : DEFAULT_IMAGE_UPLOAD_TICKET_TTL_SECONDS;
  const ttlSeconds = Number.isFinite(parsedTtl) ? parsedTtl : DEFAULT_IMAGE_UPLOAD_TICKET_TTL_SECONDS;

  return Math.min(
    Math.max(ttlSeconds, MIN_IMAGE_UPLOAD_TICKET_TTL_SECONDS),
    MAX_IMAGE_UPLOAD_TICKET_TTL_SECONDS,
  );
}

/**
 * 清理已经过期的上传票据，防止长期运行进程里内存无限增长。
 */
export function cleanupExpiredImageUploadTickets(now = Date.now()): void {
  for (const [token, ticket] of imageUploadTickets.entries()) {
    if (ticket.expiresAt <= now) {
      imageUploadTickets.delete(token);
    }
  }
}

/**
 * 创建一次性图片上传票据。
 *
 * 票据只保存在当前进程内存里，服务重启后自然失效；这比持久化更适合
 * 上传临时文件的场景，也减少了泄露后长期可用的风险。
 */
export function createImageUploadTicket(options: {
  ttlSeconds?: number;
  now?: number;
} = {}): ImageUploadTicket {
  const now = options.now ?? Date.now();
  const ttlSeconds = options.ttlSeconds ?? getImageUploadTicketTtlSeconds();
  const token = crypto.randomBytes(32).toString('base64url');
  const ticket: ImageUploadTicket = {
    token,
    createdAt: now,
    expiresAt: now + ttlSeconds * 1000,
    maxBytes: WECHAT_UPLOADIMG_MAX_SIZE_BYTES,
  };

  cleanupExpiredImageUploadTickets(now);
  imageUploadTickets.set(token, ticket);

  return ticket;
}

/**
 * 消耗一次性上传票据。
 *
 * 无论调用方后续 multipart 解析是否成功，票据都会被移除，避免同一个
 * 上传地址被重复利用。失败时客户端需要重新调用 prepare 工具获取新地址。
 */
export function consumeImageUploadTicket(
  token: string | undefined,
  now = Date.now(),
): ConsumeImageUploadTicketResult {
  if (!token) {
    return { ok: false, reason: 'missing_token' };
  }

  const ticket = imageUploadTickets.get(token);
  if (!ticket) {
    return { ok: false, reason: 'not_found' };
  }

  imageUploadTickets.delete(token);
  if (ticket.expiresAt <= now) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, ticket };
}

/**
 * 生成带一次性票据的图片上传 URL。
 */
export function buildImageUploadTicketUrl(token: string, endpoint = '/upload-image'): string | undefined {
  const publicBaseUrl = getMcpPublicBaseUrl();
  if (!publicBaseUrl) {
    return undefined;
  }

  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const uploadUrl = new URL(`${publicBaseUrl}${normalizedEndpoint}`);
  uploadUrl.searchParams.set(IMAGE_UPLOAD_TICKET_QUERY_KEY, token);

  return uploadUrl.toString();
}

/**
 * 测试与诊断时使用，生产逻辑不要依赖票据数量。
 */
export function getImageUploadTicketCount(): number {
  cleanupExpiredImageUploadTickets();
  return imageUploadTickets.size;
}
