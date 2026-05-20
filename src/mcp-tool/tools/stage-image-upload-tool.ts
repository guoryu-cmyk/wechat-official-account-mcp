import { z } from 'zod';
import { McpTool, WechatApiClient, WechatToolResult } from '../types.js';
import {
  abortChunkedImageUpload,
  appendChunkedImageUpload,
  finishChunkedImageUpload,
  IMAGE_UPLOAD_CHUNK_BASE64_CHARS,
  IMAGE_UPLOAD_MAX_CHUNK_BASE64_CHARS,
  startChunkedImageUpload,
} from '../../utils/chunked-image-upload.js';

const stageImageUploadSchema = z.object({
  action: z.enum(['start', 'append', 'finish', 'abort']),
  fileName: z.string().optional(),
  uploadId: z.string().optional(),
  chunkIndex: z.number().int().nonnegative().optional(),
  chunkData: z.string().optional(),
  totalChunks: z.number().int().positive().optional(),
  totalSize: z.number().int().positive().optional(),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
});

function jsonResult(payload: unknown): WechatToolResult {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(payload, null, 2),
    }],
  };
}

function requireString(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} 不能为空`);
  }

  return value;
}

/**
 * 通过 MCP tool 调用链路分片上传图片到服务器临时目录。
 *
 * 这个工具专门解决 ChatGPT 不能直接 curl 外部上传地址、且长 base64 又容易被截断的问题：
 * 每次只传一个受控大小的 base64 分片，全部分片到齐后再在服务器端合并、校验并落盘。
 */
async function handleStageImageUploadTool(
  args: unknown,
  apiClient: WechatApiClient,
): Promise<WechatToolResult> {
  void apiClient;
  const params = stageImageUploadSchema.parse(args || {});

  if (params.action === 'start') {
    const session = await startChunkedImageUpload({
      fileName: requireString(params.fileName, 'fileName'),
      totalChunks: params.totalChunks,
      totalSize: params.totalSize,
      expectedSha256: params.expectedSha256,
    });

    return jsonResult({
      ok: true,
      action: 'start',
      ...session,
      instructions: [
        '把本地图片转成完整 base64 字符串；如果完整 base64 长度不超过 maxChunkBase64Chars，可以只调用一次 action=append 上传唯一分片。',
        '需要多片时，优先按 chunkSizeBase64Chars 尽量切满；除最后一片外，不要故意切成很小的分片，以减少 MCP tool 调用次数。',
        '每个分片长度必须是 4 的倍数；chunkSizeBase64Chars 和 maxChunkBase64Chars 都已经按 base64 边界对齐。',
        '按 chunkIndex 从 0 开始依次调用本工具 action=append。',
        '全部 append 成功后调用 action=finish，读取返回的 filePath，再调用 wechat_upload_img。',
      ],
      bashHint: `base64 -w 0 <图片路径> | fold -w ${session.chunkSizeBase64Chars}`,
      nextCall: {
        tool: 'wechat_stage_image_upload',
        arguments: {
          action: 'append',
          uploadId: session.uploadId,
          chunkIndex: 0,
          chunkData: '<base64 chunk>',
        },
      },
    });
  }

  if (params.action === 'append') {
    const appended = await appendChunkedImageUpload({
      uploadId: requireString(params.uploadId, 'uploadId'),
      chunkIndex: params.chunkIndex ?? -1,
      chunkData: requireString(params.chunkData, 'chunkData'),
    });

    return jsonResult({
      ok: true,
      action: 'append',
      ...appended,
      nextCall: {
        tool: 'wechat_stage_image_upload',
        arguments: {
          action: 'append',
          uploadId: appended.uploadId,
          chunkIndex: appended.nextChunkIndex,
          chunkData: '<next base64 chunk>',
        },
      },
    });
  }

  if (params.action === 'finish') {
    const finished = await finishChunkedImageUpload(requireString(params.uploadId, 'uploadId'));

    return jsonResult({
      ok: true,
      action: 'finish',
      uploadId: finished.uploadId,
      chunksReceived: finished.chunksReceived,
      filePath: finished.filePath,
      fileName: finished.fileName,
      originalName: finished.originalName,
      size: finished.size,
      detectedFormat: finished.detectedFormat,
      contentType: finished.contentType,
      nextTool: {
        name: 'wechat_upload_img',
        arguments: {
          filePath: finished.filePath,
        },
      },
    });
  }

  await abortChunkedImageUpload(requireString(params.uploadId, 'uploadId'));

  return jsonResult({
    ok: true,
    action: 'abort',
    uploadId: params.uploadId,
  });
}

export const stageImageUploadTool: McpTool = {
  name: 'wechat_stage_image_upload',
  description: [
    '当 ChatGPT/远程 SSE 环境无法直接 HTTP POST /upload-image 时，用本工具通过 MCP 分片上传本地图片到服务器临时目录。',
    `调用流程：action=start 创建会话；把图片 base64 按返回的 chunkSizeBase64Chars 切块；推荐每片 ${IMAGE_UPLOAD_CHUNK_BASE64_CHARS} 个 base64 字符，单片最多 ${IMAGE_UPLOAD_MAX_CHUNK_BASE64_CHARS} 个 base64 字符；action=finish 返回服务器 filePath；最后调用 wechat_upload_img。`,
    '如果完整图片 base64 长度不超过 maxChunkBase64Chars，可以只调用一次 action=append；需要多片时，除最后一片外应尽量切满 chunkSizeBase64Chars，不要故意拆成很多小分片。',
    '每个 chunkData 长度必须是 4 的倍数；不要把超出 maxChunkBase64Chars 的完整图片 base64 一次性传给任何工具。',
    '图片最终仍按微信公众号 uploadimg 要求校验：完整 JPG/JPEG/PNG，大小不超过 1MB。',
  ].join('\n'),
  inputSchema: {
    action: z.enum(['start', 'append', 'finish', 'abort']).describe(
      'start=创建分片会话，append=追加一个 base64 分片，finish=合并并返回服务器 filePath，abort=取消会话。',
    ),
    fileName: z.string().optional().describe(
      'action=start 时必填，原始图片文件名，例如 article.jpg 或 cover.png。',
    ),
    uploadId: z.string().optional().describe(
      'action=append/finish/abort 时必填，由 start 返回。',
    ),
    chunkIndex: z.number().int().nonnegative().optional().describe(
      'action=append 时必填，从 0 开始递增，必须按顺序上传。',
    ),
    chunkData: z.string().optional().describe(
      'action=append 时必填，单个 base64 分片。优先按 start 返回的 chunkSizeBase64Chars 尽量切满；如果完整 base64 不超过 maxChunkBase64Chars，可作为唯一分片一次 append；长度必须是 4 的倍数。',
    ),
    totalChunks: z.number().int().positive().optional().describe(
      'action=start 时可选，用于 finish 时校验分片数量。',
    ),
    totalSize: z.number().int().positive().optional().describe(
      'action=start 时可选，原始图片字节数，用于提前校验 1MB 限制和 finish 校验。',
    ),
    expectedSha256: z.string().optional().describe(
      'action=start 时可选，原始图片 sha256 十六进制值，用于 finish 完整性校验。',
    ),
  },
  handler: handleStageImageUploadTool,
};
