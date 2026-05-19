#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { resolveMcpServerOptions } from './config/mcp-config.js';
import { initMcpServerWithTransport } from './mcp-server/shared/init.js';
import { logger } from './utils/logger.js';

const program = new Command();

function getVersion(): string {
  const candidates = [
    '../../package.json',
    '../package.json',
    '../../../package.json',
  ];

  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(candidate, import.meta.url), 'utf-8'));
      return pkg.version || '1.0.0';
    } catch {
      continue;
    }
  }

  return '1.0.0';
}

program
  .name('wechat-mcp')
  .description('WeChat Official Account MCP Server')
  .version(getVersion());

program
  .command('mcp')
  .description('Start WeChat MCP server')
  .option('-a, --app-id <appId>', 'WeChat App ID')
  .option('-s, --app-secret <appSecret>', 'WeChat App Secret')
  .option('-m, --mode <mode>', 'Transport mode (stdio|sse)')
  .option('-p, --port <port>', 'Port for SSE mode')
  .option('-c, --config <path>', 'Unified MCP config JSON path')
  .option('--account <name>', 'Account/profile name in config file')
  .option('--profile <name>', 'Alias of --account')
  .option('--mcp-token <token>', 'MCP access token for remote clients')
  .option('--public-base-url <url>', 'Public base URL, for example https://justin.example.com')
  .option('--upload-curl-resolve <hostPortIp>', 'curl --resolve hint, for example justin.example.com:443:1.2.3.4')
  .option('--db-path <path>', 'SQLite database path for this account')
  .option('--image-upload-dir <path>', 'Temporary image upload directory for this account')
  .option('--wechat-token <token>', 'Optional WeChat server validation token')
  .option('--encoding-aes-key <key>', 'Optional WeChat EncodingAESKey')
  .option('--sse-json-limit <limit>', 'JSON body limit for SSE/Streamable HTTP, default 16mb')
  .action(async (options) => {
    try {
      const serverOptions = resolveMcpServerOptions(options);

      logger.info(`Starting WeChat MCP Server in ${serverOptions.mode} mode...`);
      if (serverOptions.accountName) {
        logger.info(`Account profile: ${serverOptions.accountName}`);
      }
      // 只记录 App ID 的前 8 个字符，避免泄露完整凭证。
      logger.info(`App ID: ${serverOptions.appId.substring(0, 8)}...`);

      await initMcpServerWithTransport(serverOptions);
    } catch (error) {
      logger.error(`Failed to start MCP server: ${error}`);
      process.exit(1);
    }
  });

program
  .command('version')
  .description('Show version information')
  .action(() => {
    console.log(`WeChat Official Account MCP Server v${getVersion()}`);
  });

program
  .command('help')
  .description('Show help information')
  .action(() => {
    console.log('WeChat Official Account MCP Server');
    console.log('');
    console.log('Usage:');
    console.log('  npx wechat-mcp mcp -a <app_id> -s <app_secret>');
    console.log('  npx wechat-mcp mcp --config ~/.wechat-mcp/accounts.json --account justin');
    console.log('');
    console.log('Options:');
    console.log('  -a, --app-id <appId>         WeChat App ID');
    console.log('  -s, --app-secret <secret>    WeChat App Secret');
    console.log('  -m, --mode <mode>            Transport mode (stdio|sse), default: stdio');
    console.log('  -p, --port <port>            Port for SSE mode, default: 3000');
    console.log('  -c, --config <path>          Unified MCP config JSON path');
    console.log('  --account <name>             Account/profile name in config file');
    console.log('  --mcp-token <token>          MCP access token for remote clients');
    console.log('  --public-base-url <url>      Public base URL for upload helpers');
    console.log('  --db-path <path>             SQLite DB path for this account');
    console.log('  --image-upload-dir <path>    Temp upload directory for this account');
    console.log('  Environment fallback: WECHAT_MCP_CONFIG, WECHAT_MCP_ACCOUNT, WECHAT_APP_ID, WECHAT_APP_SECRET');
    console.log('');
    console.log('Examples:');
    console.log('  npx wechat-mcp mcp -a wx1234567890 -s abcdef1234567890');
    console.log('  npx wechat-mcp mcp -a wx1234567890 -s abcdef1234567890 -m sse -p 3001');
    console.log('  npx wechat-mcp mcp --config ~/.wechat-mcp/accounts.json --account zhandaren');
  });

program.parse();

// 全局错误处理，避免未捕获异常在 stdio/SSE 场景里静默失败。
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection at:', promise, 'reason:', reason);
  process.exit(1);
});
