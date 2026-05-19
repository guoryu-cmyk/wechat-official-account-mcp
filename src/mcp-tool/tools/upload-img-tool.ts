import { z } from 'zod';
import { WechatToolResult, McpTool } from '../types.js';
import { WechatApiClient } from '../../wechat/api-client.js';
import { logger } from '../../utils/logger.js';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import {
  buildImageUploadDiagnostics,
  decodeBase64ImageData,
  validateImageForUpload,
  WECHAT_UPLOADIMG_MAX_SIZE_BYTES,
  type ImageUploadDiagnostics,
} from '../../utils/image-upload.js';

/**
 * 上传图文消息图片工具处理器
 */
async function handleUploadImgTool(args: unknown, apiClient: WechatApiClient): Promise<WechatToolResult> {
  // MCP SDK已经验证了参数，直接使用
  const { filePath, fileData, fileName } = args as any;
  let diagnostics: ImageUploadDiagnostics | undefined;
  
  try {

    if (!filePath && !fileData) {
      throw new Error('文件路径或文件数据不能为空');
    }

    let fileBuffer: Buffer;
    let actualFileName: string;
    let source: ImageUploadDiagnostics['source'];

    if (filePath) {
      // 从文件路径读取
      if (!fs.existsSync(filePath)) {
        throw new Error(`文件不存在: ${filePath}`);
      }
      
      fileBuffer = fs.readFileSync(filePath);
      actualFileName = fileName || path.basename(filePath);
      source = 'filePath';
    } else if (fileData) {
      // 从 base64 数据读取
      fileBuffer = decodeBase64ImageData(fileData);
      actualFileName = fileName || 'image.jpg';
      source = 'fileData';
    } else {
      throw new Error('未提供文件数据');
    }

    // 检查文件大小（1MB限制）
    if (fileBuffer.length > WECHAT_UPLOADIMG_MAX_SIZE_BYTES) {
      throw new Error('文件大小不能超过1MB');
    }

    // 检查文件格式。既检查后缀，也检查真实文件头，避免微信侧只返回笼统的 -1。
    const { ext, detectedFormat, contentType } = validateImageForUpload(actualFileName, fileBuffer);
    diagnostics = buildImageUploadDiagnostics(
      source,
      actualFileName,
      fileBuffer,
      ext,
      detectedFormat,
      contentType,
      'media',
      '/cgi-bin/media/uploadimg',
    );

    logger.info('Preparing WeChat uploadimg request', diagnostics);

    // 准备表单数据
    const formData = new FormData();
    formData.append('media', fileBuffer, {
      filename: actualFileName,
      contentType,
    });

    // 调用微信API。使用专用方法统一携带 multipart headers，避免通用 post 漏掉 form-data 细节。
    const response = await apiClient.uploadImg(formData) as any;
    
    if (response.errcode && response.errcode !== 0) {
      logger.error('WeChat uploadimg API returned an error', {
        ...diagnostics,
        errcode: response.errcode,
        errmsg: response.errmsg,
      });
      throw new Error(`微信API错误: ${response.errmsg} (${response.errcode})`);
    }

    logger.info('Image uploaded successfully', {
      ...diagnostics,
      url: response.url,
    });

    return {
      content: [{
        type: 'text',
        text: `图片上传成功！\n图片URL: ${response.url}\n文件名: ${actualFileName}\n文件大小: ${fileBuffer.length} 字节\n格式: ${ext.substring(1)}`
      }]
    };

  } catch (error) {
    logger.error('Upload image tool error', {
      error,
      diagnostics,
    });
    return {
      content: [{
        type: 'text',
        text: `图片上传失败: ${error instanceof Error ? error.message : '未知错误'}`,
      }],
      isError: true,
    };
  }
}

/**
 * 微信公众号上传图文消息图片工具
 */
export const uploadImgTool: McpTool = {
  name: 'wechat_upload_img',
  description: [
    '远程 ChatGPT/SSE 上传本地图片时：优先调用 wechat_stage_image_upload 分片上传生成服务器 filePath，再调用本工具；不要直接传长 base64。',
    '只有客户端能直接访问外部 HTTP 上传地址时，才可改用 wechat_prepare_image_upload 生成 uploadUrl。',
    '上传微信公众号图文消息正文内使用的图片，并返回可写入文章 HTML 的图片 URL；不占用公众号永久素材库限制。',
    '图片必须是完整的 JPG/JPEG/PNG，大小不超过 1MB。',
    '本地 stdio 模式可以传 filePath；远程 SSE 模式下 filePath 必须是 MCP 服务器上的绝对路径。',
    '如果只能传 fileData，请提供完整 base64 和 fileName，支持自动剥离 data:image/...;base64, 前缀。',
  ].join('\n'),
  inputSchema: {
    filePath: z.string().optional().describe(
      'MCP 服务器本地图片绝对路径（与 fileData 二选一）。远程 SSE 模式下不能传用户电脑本地路径；请先调用 wechat_stage_image_upload，finish 成功后把响应里的 filePath 传给本工具。',
    ),
    fileData: z.string().optional().describe(
      '完整图片 base64（与 filePath 二选一）。仅在小图且无法使用 wechat_stage_image_upload 时兜底使用；长 base64 容易被 AI/MCP JSON 调用链路截断。支持 data:image/...;base64, 前缀。',
    ),
    fileName: z.string().optional().describe(
      '使用 fileData 时建议提供文件名，例如 image.jpg 或 image.png；使用 filePath 时默认从路径提取。',
    )
  },
  handler: handleUploadImgTool
};
