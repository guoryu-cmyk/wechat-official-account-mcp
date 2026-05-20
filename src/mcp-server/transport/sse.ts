import { randomUUID } from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { InitTransportServerFunction } from '../shared/index.js';
import { logger } from '../../utils/logger.js';
import {
  saveUploadedImageToTemp,
} from './image-upload.js';
import {
  WECHAT_UPLOADIMG_MAX_SIZE_BYTES,
} from '../../utils/image-upload.js';
import {
  consumeImageUploadTicket,
  IMAGE_UPLOAD_TICKET_HEADER,
  IMAGE_UPLOAD_TICKET_QUERY_KEY,
} from '../../utils/image-upload-ticket.js';
import {
  CHATGPT_BUNDLE_DOWNLOAD_ENDPOINT,
  CHATGPT_BUNDLE_DOWNLOAD_TOKEN_QUERY_KEY,
  CHATGPT_BUNDLE_UPLOAD_ENDPOINT,
  consumeUploadedChatGPTBundleFile,
  createUploadedChatGPTBundleFileRef,
  getMaxChatGPTAssetZipBytes,
} from '../../utils/chatgpt-assets.js';

type SseRequestLike = {
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
};

const MESSAGE_ENDPOINT = '/messages';
const STREAMABLE_HTTP_ENDPOINT = '/mcp';
const IMAGE_UPLOAD_ENDPOINT = '/upload-image';
const TOKEN_QUERY_KEY = 'token';
const DEFAULT_SSE_JSON_BODY_LIMIT = '16mb';
const MCP_SESSION_ID_HEADER = 'mcp-session-id';

function getSingleQueryValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getSingleHeaderValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.find(item => typeof item === 'string' && item.length > 0);
  }

  return undefined;
}

function getBearerToken(authHeader: unknown): string | undefined {
  if (typeof authHeader !== 'string') {
    return undefined;
  }

  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return undefined;
  }

  return token;
}

function getSseQueryToken(req: SseRequestLike): string | undefined {
  return getSingleQueryValue(req.query?.[TOKEN_QUERY_KEY]);
}

function getImageUploadTicketToken(req: SseRequestLike): string | undefined {
  return (
    getSingleQueryValue(req.query?.[IMAGE_UPLOAD_TICKET_QUERY_KEY]) ||
    getSingleHeaderValue(req.headers?.[IMAGE_UPLOAD_TICKET_HEADER])
  );
}

function getMcpSessionId(req: SseRequestLike): string | undefined {
  return getSingleHeaderValue(req.headers?.[MCP_SESSION_ID_HEADER]);
}

/**
 * 设置 SSE 相关 HTTP 端点的跨域响应头。
 *
 * /upload-image 可能被浏览器或外部客户端直接调用；这里保持和 /sse 一致，
 * 但真正写入文件的 POST 请求仍会走 MCP_AUTH_TOKEN 鉴权。
 */
function setSseCorsHeaders(res: express.Response): void {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader(
    'Access-Control-Allow-Headers',
    `Cache-Control, Content-Type, Authorization, ${IMAGE_UPLOAD_TICKET_HEADER}, Mcp-Session-Id, mcp-session-id, Last-Event-ID`,
  );
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
}

/**
 * 生成 MCP SSE 握手时广播给客户端的消息回传地址。
 * 当用户通过 ChatGPT 的“未授权”模式传入 URL token 时，需要把 token
 * 继续放进 /messages 地址里，否则 ChatGPT 后续 POST 调用会丢失鉴权信息。
 */
export function buildSseMessageEndpoint(token?: string): string {
  if (!token) {
    return MESSAGE_ENDPOINT;
  }

  const searchParams = new URLSearchParams({ [TOKEN_QUERY_KEY]: token });
  return `${MESSAGE_ENDPOINT}?${searchParams.toString()}`;
}

/**
 * 校验 SSE 与消息回传请求是否具备访问权限。
 * 未配置 MCP_AUTH_TOKEN 时保持历史兼容，允许本地/内网无认证访问；公网部署必须配置该环境变量。
 */
export function isSseRequestAuthorized(
  req: SseRequestLike,
  expectedToken = process.env.MCP_AUTH_TOKEN,
): boolean {
  if (!expectedToken) {
    return true;
  }

  const queryToken = getSseQueryToken(req);
  const bearerToken = getBearerToken(req.headers?.authorization);

  return queryToken === expectedToken || bearerToken === expectedToken;
}

/**
 * 校验图片上传 HTTP 接口的访问权限。
 *
 * /upload-image 继续兼容原来的 MCP_AUTH_TOKEN，同时支持 prepare 工具生成的
 * 一次性 upload_token。这样 AI 可以通过 MCP 工具拿到短期上传地址，而不需要知道
 * 长期服务 token。
 */
function isImageUploadRequestAuthorized(
  req: SseRequestLike,
  expectedToken = process.env.MCP_AUTH_TOKEN,
): boolean {
  if (isSseRequestAuthorized(req, expectedToken)) {
    return true;
  }

  const consumeResult = consumeImageUploadTicket(getImageUploadTicketToken(req));
  if ('reason' in consumeResult) {
    logger.warn('Rejected image upload request', { reason: consumeResult.reason });
    return false;
  }

  logger.info('Accepted one-time image upload ticket', {
    expiresAt: new Date(consumeResult.ticket.expiresAt).toISOString(),
  });
  return true;
}

export function getSseJsonBodyLimit(): string {
  return process.env.MCP_SSE_JSON_LIMIT || DEFAULT_SSE_JSON_BODY_LIMIT;
}

export const initSSEServer: InitTransportServerFunction = async (
  getNewServer,
  options,
) => {
  const { appId, appSecret, port = '3000' } = options;

  if (!appId || !appSecret) {
    logger.error('Missing App ID or App Secret');
    process.exit(1);
  }

  const app = express();
  app.use(express.json({ limit: getSseJsonBodyLimit() }));
  const transports = new Map<string, SSEServerTransport>();
  const streamableTransports = new Map<string, StreamableHTTPServerTransport>();
  const expectedToken = options.mcpAuthToken || process.env.MCP_AUTH_TOKEN;
  const imageUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: WECHAT_UPLOADIMG_MAX_SIZE_BYTES,
      files: 1,
    },
  });
  const chatGPTBundleUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: getMaxChatGPTAssetZipBytes(),
      files: 1,
    },
  });

  if (!expectedToken) {
    logger.warn('MCP_AUTH_TOKEN is not set; SSE transport will accept unauthenticated requests.');
  }

  // 错误处理中间件
  app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    void _next;
    logger.error('SSE server error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * 现代 MCP 客户端优先使用 Streamable HTTP。保留 /mcp 作为标准入口，同时让
   * /sse 的 POST/带 Mcp-Session-Id 的 GET 也走这里，避免用户在 ChatGPT 里
   * 已经配置了旧 /sse 地址时，客户端用新协议调用工具却拿到 SSE 握手帧。
   */
  const handleStreamableHttpRequest = async (req: express.Request, res: express.Response) => {
    let transport: StreamableHTTPServerTransport | undefined;

    try {
      if (!isSseRequestAuthorized(req, expectedToken)) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      setSseCorsHeaders(res);

      const sessionId = getMcpSessionId(req);
      if (sessionId) {
        transport = streamableTransports.get(sessionId);
      }

      if (!transport && req.method === 'POST' && !sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          // 使用服务端生成的随机 session，后续请求通过 Mcp-Session-Id 头找回同一个连接状态。
          sessionIdGenerator: () => randomUUID(),
          // 对当前工具场景直接返回 JSON 更稳定，避免部分代理把长连接误判为超时。
          enableJsonResponse: true,
          onsessioninitialized: initializedSessionId => {
            if (transport) {
              streamableTransports.set(initializedSessionId, transport);
              logger.info('Streamable HTTP MCP session initialized', { sessionId: initializedSessionId });
            }
          },
          onsessionclosed: closedSessionId => {
            streamableTransports.delete(closedSessionId);
            logger.info('Streamable HTTP MCP session closed', { sessionId: closedSessionId });
          },
        });

        transport.onclose = () => {
          if (transport?.sessionId) {
            streamableTransports.delete(transport.sessionId);
          }
        };
        transport.onerror = error => {
          logger.error('Streamable HTTP transport error:', error);
        };

        const mcpServer = await getNewServer(options);
        await mcpServer.connect(transport);
      }

      if (!transport) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid MCP session. Send initialize first, then reuse Mcp-Session-Id.',
          },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.method === 'POST' ? req.body : undefined);
    } catch (error) {
      logger.error('Error in Streamable HTTP handler:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        });
      }
    }
  };

  app.options(
    [
      STREAMABLE_HTTP_ENDPOINT,
      '/sse',
      MESSAGE_ENDPOINT,
      IMAGE_UPLOAD_ENDPOINT,
      CHATGPT_BUNDLE_UPLOAD_ENDPOINT,
      `${CHATGPT_BUNDLE_DOWNLOAD_ENDPOINT}/:fileId`,
    ],
    (_req, res) => {
    setSseCorsHeaders(res);
    res.status(204).send();
    },
  );

  app.all(STREAMABLE_HTTP_ENDPOINT, handleStreamableHttpRequest);
  app.post('/sse', handleStreamableHttpRequest);
  app.delete('/sse', handleStreamableHttpRequest);

  app.get('/sse', async (req, res) => {
    if (getMcpSessionId(req)) {
      await handleStreamableHttpRequest(req, res);
      return;
    }

    let transport: SSEServerTransport | undefined;

    try {
      if (!isSseRequestAuthorized(req, expectedToken)) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      setSseCorsHeaders(res);

      // 为每个 SSE 连接创建独立 transport，后续 /messages 通过 sessionId 找回它。
      const messageEndpoint = buildSseMessageEndpoint(getSseQueryToken(req));
      transport = new SSEServerTransport(messageEndpoint, res);
      transports.set(transport.sessionId, transport);
      const mcpServer = await getNewServer(options);

      await mcpServer.connect(transport);

      req.on('close', async () => {
        try {
          logger.info('SSE connection closed, cleaning up...');
          transports.delete(transport.sessionId);
        } catch (error) {
          logger.error('Error during SSE cleanup:', error);
        }
      });

      req.on('error', (error) => {
        logger.error('SSE request error:', error);
      });
    } catch (error) {
      if (transport) {
        transports.delete(transport.sessionId);
      }

      logger.error('Error in SSE handler:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to establish SSE connection' });
      }
    }
  });

  app.post(IMAGE_UPLOAD_ENDPOINT, (req, res) => {
    setSseCorsHeaders(res);

    if (!isImageUploadRequestAuthorized(req, expectedToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    imageUpload.single('file')(req, res, async (uploadError: unknown) => {
      try {
        if (uploadError) {
          const errorCode = (uploadError as { code?: string }).code;
          if (errorCode === 'LIMIT_FILE_SIZE') {
            res.status(413).json({ error: '文件大小不能超过1MB' });
            return;
          }

          throw uploadError;
        }

        if (!req.file) {
          res.status(400).json({ error: '缺少 multipart/form-data 文件字段 file' });
          return;
        }

        const savedImage = await saveUploadedImageToTemp({
          buffer: req.file.buffer,
          originalName: req.file.originalname,
        });

        logger.info('SSE image uploaded to server temp directory', {
          filePath: savedImage.filePath,
          fileName: savedImage.fileName,
          originalName: savedImage.originalName,
          size: savedImage.size,
          detectedFormat: savedImage.detectedFormat,
          contentType: savedImage.contentType,
        });

        res.json({
          ok: true,
          filePath: savedImage.filePath,
          fileName: savedImage.fileName,
          originalName: savedImage.originalName,
          size: savedImage.size,
          detectedFormat: savedImage.detectedFormat,
          contentType: savedImage.contentType,
          nextTool: {
            name: 'wechat_upload_img',
            arguments: {
              filePath: savedImage.filePath,
            },
          },
        });
      } catch (error) {
        logger.error('SSE image upload failed:', error);
        if (!res.headersSent) {
          res.status(400).json({
            error: error instanceof Error ? error.message : '图片上传失败',
          });
        }
      }
    });
  });

  app.post(CHATGPT_BUNDLE_UPLOAD_ENDPOINT, (req, res) => {
    setSseCorsHeaders(res);

    const consumeResult = consumeImageUploadTicket(getImageUploadTicketToken(req));
    if ('reason' in consumeResult) {
      logger.warn('Rejected ChatGPT bundle upload request', { reason: consumeResult.reason });
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    chatGPTBundleUpload.single('file')(req, res, async (uploadError: unknown) => {
      try {
        if (uploadError) {
          const errorCode = (uploadError as { code?: string }).code;
          if (errorCode === 'LIMIT_FILE_SIZE') {
            res.status(413).json({
              error: `ZIP 文件大小不能超过 ${getMaxChatGPTAssetZipBytes()} 字节`,
            });
            return;
          }

          throw uploadError;
        }

        if (!req.file) {
          res.status(400).json({ error: '缺少 multipart/form-data 文件字段 file' });
          return;
        }

        if (req.file.size > consumeResult.ticket.maxBytes) {
          res.status(413).json({
            error: `ZIP 文件大小不能超过 ${consumeResult.ticket.maxBytes} 字节`,
          });
          return;
        }

        const publicBaseUrl = process.env.MCP_PUBLIC_BASE_URL?.trim();
        if (!publicBaseUrl) {
          res.status(500).json({ error: '服务端未配置 MCP_PUBLIC_BASE_URL，无法生成临时下载地址' });
          return;
        }

        const bundle = createUploadedChatGPTBundleFileRef({
          publicBaseUrl,
          buffer: req.file.buffer,
          fileName: req.file.originalname || 'chatgpt-article-bundle.zip',
          mimeType: req.file.mimetype || 'application/zip',
        });

        logger.info('ChatGPT bundle uploaded to MCP memory store', {
          fileId: bundle.file_id,
          fileName: bundle.file_name,
          size: req.file.size,
          mimeType: bundle.mime_type,
        });

        res.json({
          ok: true,
          bundle,
          size: req.file.size,
          nextTool: {
            name: 'wechat_process_article_bundle_from_chatgpt_file',
            arguments: {
              bundle,
            },
          },
        });
      } catch (error) {
        logger.error('ChatGPT bundle upload failed:', error);
        if (!res.headersSent) {
          res.status(400).json({
            error: error instanceof Error ? error.message : 'ZIP 素材包上传失败',
          });
        }
      }
    });
  });

  app.get(`${CHATGPT_BUNDLE_DOWNLOAD_ENDPOINT}/:fileId`, (req, res) => {
    const token = getSingleQueryValue(req.query[CHATGPT_BUNDLE_DOWNLOAD_TOKEN_QUERY_KEY]);
    const result = consumeUploadedChatGPTBundleFile(req.params.fileId, token);

    if ('reason' in result) {
      logger.warn('Rejected ChatGPT bundle download request', {
        fileId: req.params.fileId,
        reason: result.reason,
      });
      res.status(result.reason === 'expired' ? 410 : 404).json({ error: 'File not found or expired' });
      return;
    }

    res.setHeader('Content-Type', result.file.mimeType || 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(result.file.fileName)}"`,
    );
    res.send(result.file.buffer);
  });

  app.post('/messages', async (req, res) => {
    try {
      if (!isSseRequestAuthorized(req, expectedToken)) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const sessionId = getSingleQueryValue(req.query.sessionId);
      if (!sessionId) {
        res.status(400).send('Missing sessionId');
        return;
      }

      const transport = transports.get(sessionId);
      if (!transport) {
        res.status(400).send('No transport found for sessionId');
        return;
      }

      await transport.handlePostMessage(req, res, req.body);
    } catch (error) {
      logger.error('Error in SSE message handler:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to handle SSE message' });
      }
    }
  });

  // 创建 HTTP 服务器
  const server = app.listen(port, () => {
    logger.info(`SSE server listening on port ${port}`);
  });

  // 处理服务器错误
  server.on('error', (error) => {
    logger.error('HTTP server error:', error);
  });

  logger.info(
    `[SSEServerTransport] Connecting to WeChat MCP Server, appId: ${appId.substring(0, 8)}...`,
  );

  // 优雅关闭处理
  const shutdown = async (signal: string) => {
    logger.info(`[SSEServerTransport] Received ${signal}, shutting down gracefully...`);

    try {
      // 停止接受新连接
      server.close(() => {
        logger.info('HTTP server closed');
        process.exit(0);
      });

      // 如果5秒后还没关闭,强制退出
      setTimeout(() => {
        logger.warn('Forcing shutdown after timeout');
        process.exit(1);
      }, 5000);
    } catch (error) {
      logger.error('Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 捕获未处理的异常
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception:', error);
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection at:', promise, 'reason:', reason);
    shutdown('unhandledRejection');
  });
};
