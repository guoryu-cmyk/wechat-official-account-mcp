import { z } from 'zod';
import { McpTool, WechatApiClient, WechatToolResult } from '../types.js';
import {
  getArticleWorkspace,
  CHATGPT_BUNDLE_UPLOAD_ENDPOINT,
  getMaxChatGPTAssetZipBytes,
  processArticleBundleFromChatGPTFile,
  uploadWorkspaceImageFromChatGPTFile,
  type ChatGPTFileRef,
  type ChatGPTAssetRole,
} from '../../utils/chatgpt-assets.js';
import { logger } from '../../utils/logger.js';
import {
  buildImageUploadTicketUrl,
  createImageUploadTicket,
} from '../../utils/image-upload-ticket.js';
import { CHATGPT_ASSET_WIDGET_URI } from './chatgpt-asset-widget.js';

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

const workflowSchema = z.object({
  intent: z.string().optional().describe('用户当前想了解或执行的公众号图文流程，可为空。'),
});

const articleBundleContract = {
  contractVersion: 'wechat-chatgpt-article-bundle/v1',
  purpose: '让 ChatGPT 生成的公众号文章、图片与 MCP 上传解析保持一致。',
  zipRootLayout: {
    required: [
      'manifest.json',
      'article.md 或 article.html',
      'images/',
    ],
    example: [
      'manifest.json',
      'article.md',
      'images/cover.png',
      'images/process-diagram.png',
      'images/product-shot.png',
    ],
  },
  articleRules: [
    '文章正文里的图片必须写成 asset://image/<assetId>。',
    'assetId 必须与 manifest.images[].id 完全一致。',
    '不要在正文里引用 images/*.png、相对路径、绝对路径或第几张图。',
    'Markdown 示例：![流程图](asset://image/process-diagram)',
    'HTML 示例：<img src="asset://image/process-diagram" alt="流程图" />',
  ],
  manifestSchema: {
    topicSlug: 'string，可选，ChatGPT 生成的人类可读主题 slug',
    article: 'string，必填，文章文件路径，例如 article.md',
    title: 'string，建议必填，草稿标题',
    author: 'string，可选',
    digest: 'string，可选，草稿摘要',
    contentSourceUrl: 'string，可选，原文链接',
    images: [
      {
        id: 'string，必填，稳定图片 ID，只能使用字母、数字、下划线、短横线',
        path: 'string，必填，ZIP 内图片路径，例如 images/cover.png',
        role: 'cover 或 inline；必须且只能有一张 cover',
        label: 'string，强烈建议填写，给用户看的图片名称，例如 正文图 1：流程图',
        alt: 'string，建议填写，图片替代文本',
        caption: 'string，建议填写，说明图片在文章中的作用或位置',
        sha256: 'string，可选，图片 sha256，用于完整性校验',
      },
    ],
  },
  manifestExample: {
    topicSlug: 'ai-agent-wechat-article',
    article: 'article.md',
    title: 'AI Agent 如何提升公众号内容生产效率',
    author: 'ChatGPT',
    digest: '一篇介绍 AI Agent 内容生产流程的图文文章。',
    images: [
      {
        id: 'cover',
        path: 'images/cover.png',
        role: 'cover',
        label: '封面图',
        alt: '文章封面',
        caption: '用于公众号草稿封面',
        sha256: '<optional sha256>',
      },
      {
        id: 'process-diagram',
        path: 'images/process-diagram.png',
        role: 'inline',
        label: '正文图 1：AI Agent 内容生产流程图',
        alt: 'AI Agent 内容生产流程图',
        caption: '放在流程说明小节，用于展示从选题到发布的步骤',
        sha256: '<optional sha256>',
      },
      {
        id: 'product-shot',
        path: 'images/product-shot.png',
        role: 'inline',
        label: '正文图 2：产品界面截图',
        alt: '产品界面截图',
        caption: '放在工具体验小节，用于说明核心操作界面',
        sha256: '<optional sha256>',
      },
    ],
  },
};

function jsonText(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

function toolResult(
  payload: Record<string, unknown>,
  textPrefix?: string,
  meta?: Record<string, unknown>,
): WechatToolResult {
  return {
    structuredContent: payload,
    _meta: meta,
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
  const ticket = createImageUploadTicket({ maxBytes: getMaxChatGPTAssetZipBytes() });
  const uploadUrl = buildImageUploadTicketUrl(ticket.token, CHATGPT_BUNDLE_UPLOAD_ENDPOINT);
  const bundleUpload = uploadUrl
    ? {
        uploadUrl,
        method: 'POST',
        contentType: 'multipart/form-data',
        formField: 'file',
        maxBytes: ticket.maxBytes,
        allowedExtensions: ['zip'],
        expiresAt: new Date(ticket.expiresAt).toISOString(),
        oneTime: true,
      }
    : undefined;

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
  }, '已打开 ChatGPT 公众号素材包上传界面。', bundleUpload ? { chatgptBundleUpload: bundleUpload } : undefined);
}

async function handleGetChatGPTArticleWorkflow(args: unknown): Promise<WechatToolResult> {
  const params = workflowSchema.parse(args || {});
  const workflow = {
    ok: true,
    intent: params.intent,
    summary: 'ChatGPT 生成公众号图文时，应先生成文章、图片和 manifest.json，打包成 ZIP，由用户在上传 Widget 中上传，然后 MCP 按 assetId 精确上传图片并返回可创建草稿的数据。',
    bundleContract: articleBundleContract,
    generationInstructions: [
      '在开始生成公众号图文文章时，先调用本工具读取 bundleContract。',
      '生成文章文件时，所有图片位置必须使用 asset://image/<assetId> 占位。',
      '每生成一张图片，就为它分配稳定 assetId，并在 manifest.images 中记录 id、path、role、label、alt、caption。',
      '正文图的 label 建议写成“正文图 1：用途描述”“正文图 2：用途描述”，便于用户在 Widget 中点选替换。',
      '必须生成一张且只能一张 role=cover 的封面图。',
      '把 manifest.json、文章文件和 images/ 目录一起打包成 ZIP。',
      '打开上传 Widget 前，先确认 ZIP 根目录直接包含 manifest.json，不要再套一层父目录。',
    ],
    recommendedFlow: [
      {
        step: 1,
        actor: 'ChatGPT',
        action: '生成 article.md 或 article.html、配图和 manifest.json。',
      },
      {
        step: 2,
        actor: 'ChatGPT',
        action: '正文里的每张图片都使用 asset://image/<assetId> 引用，不使用文件顺序猜图。',
      },
      {
        step: 3,
        actor: 'ChatGPT',
        action: '把 manifest.json、文章文件和 images/ 目录打包成一个 ZIP，交给用户下载。',
      },
      {
        step: 4,
        actor: 'ChatGPT',
        action: '调用 wechat_open_asset_bundle_upload 打开上传 Widget，让用户上传这个 ZIP。',
      },
      {
        step: 5,
        actor: 'Widget/MCP',
        action: 'Widget 上传 ZIP 后调用 wechat_process_article_bundle_from_chatgpt_file。MCP 会创建或覆盖 directoryId 对应的主题目录。',
      },
      {
        step: 6,
        actor: 'MCP',
        action: 'MCP 解压 ZIP、校验 manifest、校验 sha256、上传 inline 图片获取 wechatUrl、上传 cover 获取 mediaId。',
      },
      {
        step: 7,
        actor: 'ChatGPT',
        action: '使用返回的 nextTool.arguments 或 draftArticle 调用 wechat_draft 创建草稿。',
      },
      {
        step: 8,
        actor: 'ChatGPT',
        action: '同一主题后续重传 ZIP、替换单图、查看状态、创建草稿时都继续传 MCP 返回的 directoryId。',
      },
    ],
    zipLayout: {
      requiredFiles: [
        'manifest.json',
        'article.md 或 article.html',
        'images/cover.png',
        'images/<inline-image>.png',
      ],
      exampleArticleReference: '![流程图](asset://image/process-diagram)',
      manifestExample: {
        topicSlug: 'ai-agent-wechat-article',
        article: 'article.md',
        title: '文章标题',
        author: '作者',
        digest: '摘要',
        images: [
          {
            id: 'cover',
            path: 'images/cover.png',
            role: 'cover',
            sha256: '<optional sha256>',
          },
          {
            id: 'process-diagram',
            path: 'images/process-diagram.png',
            role: 'inline',
            sha256: '<optional sha256>',
          },
        ],
      },
    },
    rules: [
      '图片身份以 manifest.images[].id 为准。',
      '正文只引用 asset://image/<assetId>，MCP 只按 assetId 替换为微信 URL。',
      'cover 图片返回 mediaId，用作草稿 thumbMediaId。',
      'inline 图片返回 wechatUrl，用作正文 img src。',
      '首次处理返回 directoryId；后续同一篇文章必须复用该 directoryId。',
    ],
    validationChecklist: [
      'ZIP 根目录存在 manifest.json。',
      'manifest.article 指向的 article.md 或 article.html 真实存在。',
      'manifest.images 中必须且只能有一个 role=cover。',
      'article 中每个 asset://image/<id> 都能在 manifest.images[].id 找到。',
      'manifest.images[].path 指向的图片真实存在，且图片是 jpg/jpeg/png。',
      'manifest.images[].label/alt/caption 应尽量写清楚图片在正文中的位置和用途。',
      '不要根据图片文件名或文件顺序推断正文图片位置。',
    ],
    nextTool: {
      name: 'wechat_open_asset_bundle_upload',
      arguments: {},
    },
  };

  return toolResult(workflow, '这是 ChatGPT 创建微信公众号图文草稿的推荐流程。');
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

const workflowOutputSchema = {
  ok: z.boolean(),
  intent: z.string().optional(),
  summary: z.string(),
  bundleContract: z.record(z.unknown()),
  generationInstructions: z.array(z.string()),
  recommendedFlow: z.array(z.record(z.unknown())),
  zipLayout: z.record(z.unknown()),
  rules: z.array(z.string()),
  validationChecklist: z.array(z.string()),
  nextTool: z.record(z.unknown()),
};

export const getChatGPTArticleWorkflowTool: McpTool = {
  name: 'wechat_get_chatgpt_article_workflow',
  title: '查看 ChatGPT 公众号图文流程',
  description: [
    'Use this when the user asks how to create a WeChat Official Account article draft from ChatGPT, asks what the flow is, or seems unsure which WeChat tool to call first.',
    'This read-only tool explains the exact ChatGPT ZIP bundle workflow, manifest format, assetId mapping rules, directoryId reuse rule, and the next tool to call.',
    'Call this before generating article files so ChatGPT can create the ZIP root layout, manifest.json, cover image, and asset://image/<assetId> references exactly as MCP expects.',
    'Call this before answering workflow questions or before starting a new ChatGPT-generated article draft flow.',
  ].join('\n'),
  inputSchema: {
    intent: z.string().optional().describe('用户当前想了解或执行的公众号图文流程，可为空。'),
  },
  outputSchema: workflowOutputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  handler: handleGetChatGPTArticleWorkflow,
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
    ui: {
      resourceUri: CHATGPT_ASSET_WIDGET_URI,
    },
    'openai/outputTemplate': CHATGPT_ASSET_WIDGET_URI,
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
