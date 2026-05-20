import { z } from 'zod';
import { McpTool, WechatApiClient, WechatToolResult } from '../types.js';
import {
  getArticleWorkspace,
  processArticleBundleFromChatGPTFile,
  uploadWorkspaceImageFromChatGPTFile,
  type ChatGPTFileRef,
  type ChatGPTAssetRole,
} from '../../utils/chatgpt-assets.js';
import { logger } from '../../utils/logger.js';

const chatGPTFileRefSchema = z.object({
  file_id: z.string().optional(),
  download_url: z.string().url(),
  file_name: z.string().optional(),
  mime_type: z.string().optional(),
}).passthrough();

const processBundleSchema = z.object({
  directoryId: z.string().optional().describe('MCP 返回的不透明目录 ID。首次上传可为空，后续重传同一主题必须传入。'),
  topicSlug: z.string().optional().describe('ChatGPT 为当前主题生成的人类可读 slug，仅用于展示和记录，不作为真实路径。'),
  bundle: chatGPTFileRefSchema.describe('ChatGPT uploadFile 返回的 ZIP 文件引用，必须包含 download_url。'),
});

const uploadWorkspaceImageSchema = z.object({
  directoryId: z.string().describe('MCP 返回的不透明目录 ID，用于定位同一主题工作区。'),
  assetId: z.string().describe('工作区内稳定图片 ID，例如 cover、process-diagram。后续替换同一图片必须复用该 ID。'),
  role: z.enum(['inline', 'cover']).describe('inline=正文图片，返回 wechatUrl；cover=草稿封面，返回 mediaId。'),
  file: chatGPTFileRefSchema.describe('ChatGPT uploadFile 返回的单张图片文件引用，必须包含 download_url。'),
});

const getWorkspaceSchema = z.object({
  directoryId: z.string().describe('MCP 返回的不透明目录 ID。'),
});

function jsonText(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

function toolResult(payload: Record<string, unknown>, textPrefix?: string): WechatToolResult {
  return {
    structuredContent: payload,
    content: [{
      type: 'text',
      text: textPrefix ? `${textPrefix}\n${jsonText(payload)}` : jsonText(payload),
    }],
  };
}

function errorResult(error: unknown): WechatToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    structuredContent: {
      ok: false,
      error: message,
    },
    content: [{
      type: 'text',
      text: `ChatGPT 素材处理失败: ${message}`,
    }],
  };
}

async function handleOpenAssetBundleUpload(args: unknown): Promise<WechatToolResult> {
  const params = z.object({
    directoryId: z.string().optional(),
    topicSlug: z.string().optional(),
  }).parse(args || {});

  return toolResult({
    ok: true,
    directoryId: params.directoryId,
    topicSlug: params.topicSlug,
    workflow: {
      primaryUploadTool: 'wechat_process_article_bundle_from_chatgpt_file',
      singleImageTool: 'wechat_upload_workspace_image_from_chatgpt_file',
      requiredBundleFiles: ['manifest.json', 'article.md 或 article.html', 'images/*'],
      imageReferenceRule: '正文必须使用 asset://image/<assetId>，manifest.images[].id 必须与正文引用一一对应。',
      directoryRule: '首次上传后会返回 directoryId，后续重传 ZIP 或替换单图必须继续传该 directoryId。',
    },
  }, '已打开 ChatGPT 公众号素材包上传界面。');
}

async function handleProcessArticleBundle(
  args: unknown,
  apiClient: WechatApiClient,
): Promise<WechatToolResult> {
  try {
    const params = processBundleSchema.parse(args || {});
    const result = await processArticleBundleFromChatGPTFile({
      directoryId: params.directoryId,
      topicSlug: params.topicSlug,
      bundle: params.bundle as ChatGPTFileRef,
    }, apiClient);

    return toolResult(result as unknown as Record<string, unknown>, [
      '素材包处理完成。',
      `directoryId: ${result.directoryId}`,
      `revision: ${result.revision}`,
      '后续重传 ZIP、替换单图、查看状态或创建草稿都必须继续传这个 directoryId。',
    ].join('\n'));
  } catch (error) {
    logger.error('wechat_process_article_bundle_from_chatgpt_file failed:', error);
    return errorResult(error);
  }
}

async function handleUploadWorkspaceImage(
  args: unknown,
  apiClient: WechatApiClient,
): Promise<WechatToolResult> {
  try {
    const params = uploadWorkspaceImageSchema.parse(args || {});
    const result = await uploadWorkspaceImageFromChatGPTFile({
      directoryId: params.directoryId,
      assetId: params.assetId,
      role: params.role as ChatGPTAssetRole,
      file: params.file as ChatGPTFileRef,
    }, apiClient);

    return toolResult(result as unknown as Record<string, unknown>, [
      '单图上传/替换完成。',
      `directoryId: ${result.directoryId}`,
      `revision: ${result.revision}`,
      '正文图片请使用返回的 assetId -> wechatUrl 映射，封面图请使用 mediaId。',
    ].join('\n'));
  } catch (error) {
    logger.error('wechat_upload_workspace_image_from_chatgpt_file failed:', error);
    return errorResult(error);
  }
}

async function handleGetArticleWorkspace(args: unknown): Promise<WechatToolResult> {
  try {
    const params = getWorkspaceSchema.parse(args || {});
    const result = await getArticleWorkspace(params.directoryId);

    return toolResult(result as unknown as Record<string, unknown>, '已读取 ChatGPT 文章工作区。');
  } catch (error) {
    logger.error('wechat_get_article_workspace failed:', error);
    return errorResult(error);
  }
}

const workspaceOutputSchema = {
  ok: z.boolean(),
  directoryId: z.string().optional(),
  topicSlug: z.string().optional(),
  revision: z.number().optional(),
  articleHtml: z.string().optional(),
  draftArticle: z.record(z.unknown()).optional(),
  inlineImages: z.array(z.record(z.unknown())).optional(),
  cover: z.record(z.unknown()).optional(),
  assets: z.array(z.record(z.unknown())).optional(),
  failed: z.array(z.record(z.unknown())).optional(),
  nextTool: z.record(z.unknown()).optional(),
  error: z.string().optional(),
};

export const openAssetBundleUploadTool: McpTool = {
  name: 'wechat_open_asset_bundle_upload',
  title: '打开公众号素材包上传',
  description: [
    'Use this when the user is working in ChatGPT and needs to upload a ZIP bundle for a WeChat Official Account article.',
    'This render tool opens the upload widget. The widget uploads the ZIP with window.openai.uploadFile, then calls wechat_process_article_bundle_from_chatgpt_file.',
    'Use this as the ChatGPT entry point for article assets so the workflow stays on one directoryId-based workspace.',
  ].join('\n'),
  inputSchema: {
    directoryId: z.string().optional().describe('已有工作区目录 ID。首次上传可为空，继续同一文章主题时传入。'),
    topicSlug: z.string().optional().describe('当前主题 slug，仅用于展示和记录。'),
  },
  outputSchema: workspaceOutputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  _meta: {
    'openai/outputTemplate': 'ui://wechat/chatgpt-asset-upload.html',
    'openai/widgetAccessible': true,
    'openai/toolInvocation/invoking': '正在打开素材包上传界面...',
    'openai/toolInvocation/invoked': '素材包上传界面已打开',
  },
  handler: handleOpenAssetBundleUpload,
};

export const processArticleBundleFromChatGPTFileTool: McpTool = {
  name: 'wechat_process_article_bundle_from_chatgpt_file',
  title: '处理 ChatGPT 文章素材包',
  description: [
    'Use this when ChatGPT has produced a ZIP bundle for one WeChat Official Account article and the user has uploaded that ZIP through the widget.',
    'The ZIP must contain manifest.json, article.md or article.html, and image files. Article content must reference images as asset://image/<assetId>.',
    'This tool creates or replaces one server workspace directory under the ChatGPT assets base directory, uploads inline images to WeChat uploadimg, uploads cover images as permanent media, and returns exact assetId mappings.',
    'If a prior result returned directoryId, always pass that directoryId for the same article topic.',
  ].join('\n'),
  inputSchema: {
    directoryId: z.string().optional().describe('MCP 返回的不透明目录 ID；首次为空，重传同一主题时必填。'),
    topicSlug: z.string().optional().describe('ChatGPT 生成的主题 slug，仅记录到 workspace.json，不作为真实路径。'),
    bundle: chatGPTFileRefSchema.describe('ChatGPT 上传后的 ZIP 文件引用。'),
  },
  outputSchema: workspaceOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  _meta: {
    'openai/fileParams': ['bundle'],
    'openai/toolInvocation/invoking': '正在解压并上传公众号素材包...',
    'openai/toolInvocation/invoked': '公众号素材包处理完成',
  },
  handler: handleProcessArticleBundle,
};

export const uploadWorkspaceImageFromChatGPTFileTool: McpTool = {
  name: 'wechat_upload_workspace_image_from_chatgpt_file',
  title: '替换工作区单张图片',
  description: [
    'Use this when continuing a ChatGPT WeChat article workflow and the user uploads one replacement image for an existing directoryId.',
    'Always pass the directoryId returned by wechat_process_article_bundle_from_chatgpt_file. Use the same assetId to replace the same logical image.',
    'Prefer this tool over creating a new bundle when only one cover or inline image changed.',
  ].join('\n'),
  inputSchema: {
    directoryId: z.string().describe('MCP 返回的不透明目录 ID。'),
    assetId: z.string().describe('稳定图片 ID。替换同一张逻辑图片时必须复用该 ID。'),
    role: z.enum(['inline', 'cover']).describe('inline=正文图，cover=封面图。'),
    file: chatGPTFileRefSchema.describe('ChatGPT 上传后的单图文件引用。'),
  },
  outputSchema: workspaceOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  _meta: {
    'openai/fileParams': ['file'],
    'openai/toolInvocation/invoking': '正在上传/替换工作区图片...',
    'openai/toolInvocation/invoked': '工作区图片已更新',
  },
  handler: handleUploadWorkspaceImage,
};

export const getArticleWorkspaceTool: McpTool = {
  name: 'wechat_get_article_workspace',
  title: '查看 ChatGPT 文章工作区',
  description: [
    'Use this when ChatGPT needs to inspect an existing WeChat article workspace by directoryId before replacing images, creating drafts, or explaining current mappings.',
    'If a prior tool result returned directoryId, pass it here to retrieve the latest assetId-to-WeChat mapping.',
  ].join('\n'),
  inputSchema: {
    directoryId: z.string().describe('MCP 返回的不透明目录 ID。'),
  },
  outputSchema: workspaceOutputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  handler: handleGetArticleWorkspace,
};
