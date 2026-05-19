import { z } from 'zod';
import { McpTool, WechatToolResult, WechatApiClient } from '../types.js';
import {
  buildImageUploadTicketUrl,
  createImageUploadTicket,
  DEFAULT_IMAGE_UPLOAD_TICKET_TTL_SECONDS,
  IMAGE_UPLOAD_TICKET_QUERY_KEY,
  getMcpPublicBaseUrl,
  getMcpUploadCurlResolve,
} from '../../utils/image-upload-ticket.js';

const prepareImageUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(200).optional(),
});

function formatExpiresAt(expiresAt: number): string {
  return new Date(expiresAt).toISOString();
}

/**
 * 为远程 SSE 场景准备一次性图片上传地址。
 *
 * 这个工具不直接接收图片二进制，而是把上传动作拆成两步：
 * 1. AI 先调用本工具拿到短期 uploadUrl；
 * 2. 客户端把本地图片用 multipart/form-data 上传到 uploadUrl，再把返回的 filePath
 *    传给 wechat_upload_img。
 */
async function handlePrepareImageUploadTool(
  args: unknown,
  apiClient: WechatApiClient,
): Promise<WechatToolResult> {
  void apiClient;
  const { fileName } = prepareImageUploadSchema.parse(args || {});
  const publicBaseUrl = getMcpPublicBaseUrl();

  if (!publicBaseUrl) {
    return {
      content: [{
        type: 'text',
        text: [
          '无法生成图片上传地址：服务端未配置 MCP_PUBLIC_BASE_URL。',
          '请在 SSE 服务环境变量里设置公网基础地址，例如 MCP_PUBLIC_BASE_URL=https://example.com。',
          '配置后重启 MCP 服务，再重新调用 wechat_prepare_image_upload。',
        ].join('\n'),
      }],
      isError: true,
    };
  }

  const ticket = createImageUploadTicket();
  const uploadUrl = buildImageUploadTicketUrl(ticket.token);
  const curlResolve = getMcpUploadCurlResolve();

  if (!uploadUrl) {
    throw new Error('生成图片上传地址失败：缺少公网基础地址');
  }

  const response = {
    ok: true,
    uploadUrl,
    method: 'POST',
    contentType: 'multipart/form-data',
    formField: 'file',
    fileName,
    maxBytes: ticket.maxBytes,
    allowedFormats: ['jpg', 'jpeg', 'png'],
    expiresAt: formatExpiresAt(ticket.expiresAt),
    expiresInSeconds: Math.round((ticket.expiresAt - ticket.createdAt) / 1000),
    oneTime: true,
    auth: {
      type: 'one_time_upload_token',
      queryKey: IMAGE_UPLOAD_TICKET_QUERY_KEY,
      note: 'uploadUrl 已经包含一次性上传 token，不需要也不应该附带 MCP_AUTH_TOKEN。',
    },
    networkHint: curlResolve
      ? {
          curlResolve,
          curlOption: `--resolve ${curlResolve}`,
          note: '如果执行环境无法解析 uploadUrl 的域名，curl 上传时添加该 --resolve 参数；不要把 HTTPS URL 改成 https://IP，否则会遇到 TLS 证书或反代匹配问题。',
        }
      : undefined,
    curlExample: curlResolve
      ? `curl --resolve '${curlResolve}' -X POST -F 'file=@/path/to/image.png' '${uploadUrl}'`
      : `curl -X POST -F 'file=@/path/to/image.png' '${uploadUrl}'`,
    nextStep: {
      afterUpload: '读取 /upload-image 返回的 filePath，然后调用 wechat_upload_img。',
      tool: 'wechat_upload_img',
      arguments: {
        filePath: '<filePath from upload response>',
      },
    },
  };

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(response, null, 2),
    }],
  };
}

export const prepareImageUploadTool: McpTool = {
  name: 'wechat_prepare_image_upload',
  description: [
    '仅当客户端能直接执行外部 HTTP POST 时，调用本工具生成短期一次性 uploadUrl。',
    '如果 ChatGPT 执行 curl 出现 DNS 失败、Failed to connect、HTTP_STATUS:000 等网络错误，请改用 wechat_stage_image_upload 分片上传。',
    '拿到 uploadUrl 后，用 multipart/form-data 的 file 字段上传 JPG/JPEG/PNG 图片；上传响应会返回服务器 filePath。',
    '最后调用 wechat_upload_img，并把返回的 filePath 作为参数传入；不要把长 base64 直接传给 wechat_upload_img。',
    '如果上传环境 DNS 解析域名失败，请使用返回结果里的 networkHint.curlOption，不要把 HTTPS 地址改成 IP。',
    `上传地址默认 ${DEFAULT_IMAGE_UPLOAD_TICKET_TTL_SECONDS} 秒内有效且只能使用一次，不需要 MCP_AUTH_TOKEN。`,
  ].join('\n'),
  inputSchema: {
    fileName: z.string().optional().describe(
      '可选的原始文件名，仅用于辅助日志和给调用方展示，例如 cover.jpg。',
    ),
  },
  handler: handlePrepareImageUploadTool,
};
