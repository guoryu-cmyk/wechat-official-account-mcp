import express from 'express';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { InitTransportServerFunction } from '../shared/index.js';
import { logger } from '../../utils/logger.js';

type SseRequestLike = {
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
};

const MESSAGE_ENDPOINT = '/messages';
const TOKEN_QUERY_KEY = 'token';

function getSingleQueryValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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
  app.use(express.json());
  const transports = new Map<string, SSEServerTransport>();
  const expectedToken = process.env.MCP_AUTH_TOKEN;

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

  app.get('/sse', async (req, res) => {
    let transport: SSEServerTransport | undefined;

    try {
      if (!isSseRequestAuthorized(req, expectedToken)) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
      res.setHeader('Access-Control-Allow-Headers', 'Cache-Control, Content-Type, Authorization');

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
