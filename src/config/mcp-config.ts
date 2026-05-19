import fs from 'fs';
import os from 'os';
import path from 'path';
import { McpServerOptions } from '../mcp-server/shared/types.js';

export interface CliMcpOptions {
  appId?: string;
  appSecret?: string;
  mode?: string;
  port?: string;
  config?: string;
  account?: string;
  profile?: string;
  mcpToken?: string;
  publicBaseUrl?: string;
  uploadCurlResolve?: string;
  dbPath?: string;
  imageUploadDir?: string;
  wechatToken?: string;
  encodingAESKey?: string;
  sseJsonLimit?: string;
}

interface McpConfigFile {
  defaultAccount?: string;
  defaultProfile?: string;
  accounts?: Record<string, McpAccountConfig>;
  profiles?: Record<string, McpAccountConfig>;
}

interface McpAccountConfig {
  appId?: string;
  appSecret?: string;
  token?: string;
  mcpToken?: string;
  wechatToken?: string;
  encodingAESKey?: string;
  mode?: string;
  port?: string | number;
  publicBaseUrl?: string;
  uploadCurlResolve?: string;
  dbPath?: string;
  imageUploadDir?: string;
  secretKey?: string;
  sseJsonLimit?: string;
  tools?: string[];
  wechat?: {
    appId?: string;
    appSecret?: string;
    token?: string;
    encodingAESKey?: string;
  };
  mcp?: {
    mode?: string;
    port?: string | number;
    authToken?: string;
    token?: string;
    publicBaseUrl?: string;
    uploadCurlResolve?: string;
    sseJsonLimit?: string;
    tools?: string[];
  };
  storage?: {
    dbPath?: string;
    imageUploadDir?: string;
    secretKey?: string;
  };
}

interface LoadedMcpConfig {
  config: McpConfigFile;
  configPath: string;
  configDir: string;
}

function firstNonEmpty(...values: Array<string | number | undefined>): string | undefined {
  const value = values.find(item => item !== undefined && String(item).trim().length > 0);
  return value === undefined ? undefined : String(value);
}

function normalizeMode(mode: string | undefined): 'stdio' | 'sse' {
  const normalized = (mode || 'stdio').toLowerCase();
  if (normalized !== 'stdio' && normalized !== 'sse') {
    throw new Error(`Invalid mode: ${mode}. Expected stdio or sse.`);
  }

  return normalized;
}

function expandHome(input: string): string {
  if (input === '~') {
    return os.homedir();
  }

  if (input.startsWith(`~${path.sep}`) || input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }

  return input;
}

function resolveConfigPath(configPath: string): string {
  return path.resolve(expandHome(configPath));
}

function resolveOptionalPath(value: string | undefined, configDir?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const expanded = expandHome(value);
  return path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(configDir || process.cwd(), expanded);
}

function loadConfig(configPath: string): LoadedMcpConfig {
  const resolvedPath = resolveConfigPath(configPath);
  const raw = fs.readFileSync(resolvedPath, 'utf8').replace(/^\uFEFF/, '');

  try {
    return {
      config: JSON.parse(raw) as McpConfigFile,
      configPath: resolvedPath,
      configDir: path.dirname(resolvedPath),
    };
  } catch (error) {
    throw new Error(`Failed to parse MCP config JSON: ${resolvedPath}. ${error instanceof Error ? error.message : String(error)}`);
  }
}

function getAccounts(config: McpConfigFile): Record<string, McpAccountConfig> {
  return config.accounts || config.profiles || {};
}

function selectAccount(
  loadedConfig: LoadedMcpConfig | undefined,
  accountName: string | undefined,
): { account?: McpAccountConfig; name?: string; configDir?: string; configPath?: string } {
  if (!loadedConfig) {
    return {};
  }

  const accounts = getAccounts(loadedConfig.config);
  const names = Object.keys(accounts);
  const selectedName = accountName
    || loadedConfig.config.defaultAccount
    || loadedConfig.config.defaultProfile
    || (names.length === 1 ? names[0] : undefined);

  if (!selectedName) {
    throw new Error(`MCP config contains multiple accounts. Please pass --account <name>. Available accounts: ${names.join(', ')}`);
  }

  const account = accounts[selectedName];
  if (!account) {
    throw new Error(`Account '${selectedName}' not found in MCP config. Available accounts: ${names.join(', ')}`);
  }

  return {
    account,
    name: selectedName,
    configDir: loadedConfig.configDir,
    configPath: loadedConfig.configPath,
  };
}

function parseTools(value: string[] | string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value;
  }

  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

/**
 * 从命令行、配置文件和环境变量合并出单个 MCP 实例的启动配置。
 *
 * 多公众号场景下建议每个公众号 profile 启动一个独立进程，这样数据库、临时目录、
 * MCP 鉴权 token 和公网 base URL 都不会互相污染。
 */
export function resolveMcpServerOptions(cliOptions: CliMcpOptions): McpServerOptions {
  const configPath = cliOptions.config || process.env.WECHAT_MCP_CONFIG;
  const loadedConfig = configPath ? loadConfig(configPath) : undefined;
  const accountName = cliOptions.account
    || cliOptions.profile
    || process.env.WECHAT_MCP_ACCOUNT
    || process.env.WECHAT_MCP_PROFILE;
  const selected = selectAccount(loadedConfig, accountName);
  const account = selected.account || {};

  const mode = normalizeMode(firstNonEmpty(
    cliOptions.mode,
    account.mcp?.mode,
    account.mode,
    process.env.WECHAT_MCP_MODE,
  ));

  const appId = firstNonEmpty(
    cliOptions.appId,
    account.wechat?.appId,
    account.appId,
    process.env.WECHAT_APP_ID,
  );
  const appSecret = firstNonEmpty(
    cliOptions.appSecret,
    account.wechat?.appSecret,
    account.appSecret,
    process.env.WECHAT_APP_SECRET,
  );

  if (!appId || !appSecret) {
    throw new Error('App ID and App Secret are required. Set them in CLI options, config file, or WECHAT_APP_ID/WECHAT_APP_SECRET.');
  }

  const dbPath = resolveOptionalPath(firstNonEmpty(
    cliOptions.dbPath,
    account.storage?.dbPath,
    account.dbPath,
    process.env.DB_PATH,
  ), selected.configDir);
  const imageUploadDir = resolveOptionalPath(firstNonEmpty(
    cliOptions.imageUploadDir,
    account.storage?.imageUploadDir,
    account.imageUploadDir,
    process.env.WECHAT_MCP_IMAGE_UPLOAD_DIR,
  ), selected.configDir);

  return {
    appId,
    appSecret,
    mode,
    port: firstNonEmpty(cliOptions.port, account.mcp?.port, account.port, process.env.WECHAT_MCP_PORT, '3000'),
    tools: parseTools(account.mcp?.tools || account.tools),
    config: selected.configPath,
    accountName: selected.name,
    mcpAuthToken: firstNonEmpty(
      cliOptions.mcpToken,
      account.mcp?.authToken,
      account.mcp?.token,
      account.mcpToken,
      // 顶层 token 保留给 MCP 鉴权，微信公众号服务器 token 请放到 wechat.token。
      account.token,
      process.env.MCP_AUTH_TOKEN,
    ),
    publicBaseUrl: firstNonEmpty(
      cliOptions.publicBaseUrl,
      account.mcp?.publicBaseUrl,
      account.publicBaseUrl,
      process.env.MCP_PUBLIC_BASE_URL,
    ),
    uploadCurlResolve: firstNonEmpty(
      cliOptions.uploadCurlResolve,
      account.mcp?.uploadCurlResolve,
      account.uploadCurlResolve,
      process.env.MCP_UPLOAD_CURL_RESOLVE,
    ),
    dbPath,
    imageUploadDir,
    storageSecretKey: firstNonEmpty(
      account.storage?.secretKey,
      account.secretKey,
      process.env.WECHAT_MCP_SECRET_KEY,
    ),
    wechatToken: firstNonEmpty(
      cliOptions.wechatToken,
      account.wechat?.token,
      account.wechatToken,
    ),
    encodingAESKey: firstNonEmpty(
      cliOptions.encodingAESKey,
      account.wechat?.encodingAESKey,
      account.encodingAESKey,
    ),
    sseJsonLimit: firstNonEmpty(
      cliOptions.sseJsonLimit,
      account.mcp?.sseJsonLimit,
      account.sseJsonLimit,
      process.env.MCP_SSE_JSON_LIMIT,
    ),
  };
}

/**
 * 把当前实例的配置同步到旧代码仍在读取的环境变量。
 *
 * 这些值都是进程级配置；因此多公众号需要多进程启动，而不是在同一个 Node 进程里
 * 同时挂多个不同账号。
 */
export function applyMcpRuntimeEnvironment(options: McpServerOptions): void {
  const pairs: Array<[string, string | undefined]> = [
    ['MCP_AUTH_TOKEN', options.mcpAuthToken],
    ['MCP_PUBLIC_BASE_URL', options.publicBaseUrl],
    ['MCP_UPLOAD_CURL_RESOLVE', options.uploadCurlResolve],
    ['DB_PATH', options.dbPath],
    ['WECHAT_MCP_IMAGE_UPLOAD_DIR', options.imageUploadDir],
    ['WECHAT_MCP_SECRET_KEY', options.storageSecretKey],
    ['MCP_SSE_JSON_LIMIT', options.sseJsonLimit],
  ];

  for (const [key, value] of pairs) {
    if (value !== undefined && value.length > 0) {
      process.env[key] = value;
    }
  }
}
