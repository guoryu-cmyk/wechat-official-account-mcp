import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  applyMcpRuntimeEnvironment,
  resolveMcpServerOptions,
} from './dist/src/config/mcp-config.js';

const testDir = mkdtempSync(path.join(tmpdir(), 'wechat-mcp-config-'));
const configPath = path.join(testDir, 'accounts.json');

writeFileSync(configPath, JSON.stringify({
  defaultAccount: 'justin',
  accounts: {
    justin: {
      wechat: {
        appId: 'wxjustin123456',
        appSecret: 'justin-secret',
        token: 'wechat-server-token',
        encodingAESKey: 'encoding-key',
      },
      mcp: {
        mode: 'sse',
        port: 3000,
        authToken: 'justin-mcp-token',
        publicBaseUrl: 'https://justin.guoairong.site',
        uploadCurlResolve: 'justin.guoairong.site:443:110.42.214.78',
        sseJsonLimit: '24mb',
      },
      storage: {
        dbPath: './data/justin.db',
        imageUploadDir: './temp/justin',
        secretKey: 'storage-secret',
      },
    },
    zhandaren: {
      appId: 'wxzhandaren123456',
      appSecret: 'zhandaren-secret',
      token: 'zhandaren-mcp-token',
      mode: 'sse',
      port: '3001',
      publicBaseUrl: 'https://zhandaren.guoairong.site',
      dbPath: './data/zhandaren.db',
      imageUploadDir: './temp/zhandaren',
    },
  },
}), 'utf8');

try {
  const justin = resolveMcpServerOptions({ config: configPath });

  assert.equal(justin.accountName, 'justin');
  assert.equal(justin.appId, 'wxjustin123456');
  assert.equal(justin.appSecret, 'justin-secret');
  assert.equal(justin.mode, 'sse');
  assert.equal(justin.port, '3000');
  assert.equal(justin.mcpAuthToken, 'justin-mcp-token');
  assert.equal(justin.publicBaseUrl, 'https://justin.guoairong.site');
  assert.equal(justin.uploadCurlResolve, 'justin.guoairong.site:443:110.42.214.78');
  assert.equal(justin.wechatToken, 'wechat-server-token');
  assert.equal(justin.encodingAESKey, 'encoding-key');
  assert.equal(justin.sseJsonLimit, '24mb');
  assert.equal(justin.dbPath, path.join(testDir, 'data', 'justin.db'));
  assert.equal(justin.imageUploadDir, path.join(testDir, 'temp', 'justin'));

  const zhandaren = resolveMcpServerOptions({
    config: configPath,
    account: 'zhandaren',
    port: '3999',
    mcpToken: 'cli-token',
  });

  assert.equal(zhandaren.accountName, 'zhandaren');
  assert.equal(zhandaren.appId, 'wxzhandaren123456');
  assert.equal(zhandaren.port, '3999');
  assert.equal(zhandaren.mcpAuthToken, 'cli-token');
  assert.equal(zhandaren.dbPath, path.join(testDir, 'data', 'zhandaren.db'));

  assert.throws(
    () => resolveMcpServerOptions({ config: configPath, account: 'missing' }),
    /Account 'missing' not found/,
  );

  applyMcpRuntimeEnvironment(justin);
  assert.equal(process.env.MCP_AUTH_TOKEN, 'justin-mcp-token');
  assert.equal(process.env.MCP_PUBLIC_BASE_URL, 'https://justin.guoairong.site');
  assert.equal(process.env.DB_PATH, path.join(testDir, 'data', 'justin.db'));
  assert.equal(process.env.WECHAT_MCP_IMAGE_UPLOAD_DIR, path.join(testDir, 'temp', 'justin'));
  assert.equal(process.env.WECHAT_MCP_SECRET_KEY, 'storage-secret');
  assert.equal(process.env.MCP_SSE_JSON_LIMIT, '24mb');

  console.log('Unified MCP config verified');
} finally {
  delete process.env.MCP_AUTH_TOKEN;
  delete process.env.MCP_PUBLIC_BASE_URL;
  delete process.env.MCP_UPLOAD_CURL_RESOLVE;
  delete process.env.DB_PATH;
  delete process.env.WECHAT_MCP_IMAGE_UPLOAD_DIR;
  delete process.env.WECHAT_MCP_SECRET_KEY;
  delete process.env.MCP_SSE_JSON_LIMIT;
  rmSync(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
