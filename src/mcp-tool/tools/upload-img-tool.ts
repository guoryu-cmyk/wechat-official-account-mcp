import { z } from 'zod';
import { WechatToolResult, McpTool } from '../types.js';
import { WechatApiClient } from '../../wechat/api-client.js';
import { logger } from '../../utils/logger.js';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';

type SupportedImageFormat = 'jpeg' | 'png';

interface ImageUploadDiagnostics {
  source: 'filePath' | 'fileData';
  fileName: string;
  size: number;
  extension: string;
  detectedFormat: SupportedImageFormat | 'unknown';
  contentType: string;
  magicHead: string;
  magicTail: string;
  jpegHasEoi?: boolean;
  pngHasIend?: boolean;
  multipartField: 'media';
  endpoint: '/cgi-bin/media/uploadimg';
}

/**
 * 将 fileData 解码为图片 Buffer。
 *
 * ChatGPT 等客户端有时会传 data:image/...;base64, 前缀，或者在 base64
 * 中插入换行。这里统一剥离前缀和空白字符；但不会在日志里输出原始 base64，
 * 避免大日志和敏感内容泄露。
 */
function decodeBase64ImageData(fileData: string): Buffer {
  const trimmed = fileData.trim();
  const commaIndex = trimmed.indexOf(',');
  const base64Text = trimmed.startsWith('data:') && commaIndex >= 0
    ? trimmed.slice(commaIndex + 1)
    : trimmed;
  const normalized = base64Text.replace(/\s/g, '');

  if (!normalized) {
    throw new Error('fileData 不能为空');
  }

  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    throw new Error('fileData 不是有效的 base64');
  }

  const buffer = Buffer.from(normalized, 'base64');
  if (buffer.length === 0) {
    throw new Error('fileData 解码后为空');
  }

  return buffer;
}

/**
 * 根据文件名后缀推导图片格式。
 */
function getFormatFromExtension(ext: string): SupportedImageFormat | undefined {
  if (ext === '.jpg' || ext === '.jpeg') {
    return 'jpeg';
  }

  if (ext === '.png') {
    return 'png';
  }

  return undefined;
}

/**
 * 根据文件内容识别真实图片格式。
 *
 * 只依赖魔数，不信任 fileName。这样能提前发现“文件名是 jpg，
 * 但 base64 实际是 png/损坏数据”的问题，避免把坏请求交给微信后只得到 -1。
 */
function detectImageFormat(buffer: Buffer): SupportedImageFormat | 'unknown' {
  const isJpeg = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8;
  if (isJpeg) {
    return 'jpeg';
  }

  const pngSignature = '89504e470d0a1a0a';
  if (buffer.length >= 8 && buffer.subarray(0, 8).toString('hex') === pngSignature) {
    return 'png';
  }

  return 'unknown';
}

/**
 * 判断 JPEG 是否包含 EOI 结束标记。
 *
 * 截断的 JPEG 常会被微信返回为 -1 system error；本地先识别出来，
 * 日志会更直接，用户也能知道该重新生成或重新传图。
 */
function hasJpegEndOfImage(buffer: Buffer): boolean {
  for (let index = buffer.length - 2; index >= 0; index -= 1) {
    if (buffer[index] === 0xff && buffer[index + 1] === 0xd9) {
      return true;
    }
  }

  return false;
}

/**
 * 判断 PNG 是否包含标准 IEND 结束块。
 */
function hasPngIend(buffer: Buffer): boolean {
  return buffer.length >= 12
    && buffer.subarray(buffer.length - 12).toString('hex') === '0000000049454e44ae426082';
}

/**
 * 构建图片上传诊断信息。
 *
 * 诊断只包含元数据和魔数，不包含图片正文/base64，便于线上安全排查。
 */
function buildImageUploadDiagnostics(
  source: ImageUploadDiagnostics['source'],
  fileName: string,
  fileBuffer: Buffer,
  ext: string,
  detectedFormat: SupportedImageFormat | 'unknown',
  contentType: string
): ImageUploadDiagnostics {
  const diagnostics: ImageUploadDiagnostics = {
    source,
    fileName,
    size: fileBuffer.length,
    extension: ext,
    detectedFormat,
    contentType,
    magicHead: fileBuffer.subarray(0, 12).toString('hex'),
    magicTail: fileBuffer.subarray(Math.max(0, fileBuffer.length - 12)).toString('hex'),
    multipartField: 'media',
    endpoint: '/cgi-bin/media/uploadimg',
  };

  if (detectedFormat === 'jpeg') {
    diagnostics.jpegHasEoi = hasJpegEndOfImage(fileBuffer);
  }

  if (detectedFormat === 'png') {
    diagnostics.pngHasIend = hasPngIend(fileBuffer);
  }

  return diagnostics;
}

/**
 * 校验图片格式并返回微信上传所需的 Content-Type。
 */
function validateImageForUpload(fileName: string, fileBuffer: Buffer): {
  ext: string;
  detectedFormat: SupportedImageFormat;
  contentType: string;
} {
  const ext = path.extname(fileName).toLowerCase();
  const expectedFormat = getFormatFromExtension(ext);

  if (!expectedFormat) {
    throw new Error('仅支持 jpg/png 格式的图片');
  }

  const detectedFormat = detectImageFormat(fileBuffer);
  if (detectedFormat === 'unknown') {
    const magicHead = fileBuffer.subarray(0, 12).toString('hex') || 'empty';
    throw new Error(`图片内容不是有效的 jpg/png，文件头: ${magicHead}`);
  }

  if (detectedFormat !== expectedFormat) {
    throw new Error(`文件名后缀为 ${ext}，但图片内容识别为 ${detectedFormat}，请修正 fileName 或图片内容`);
  }

  if (detectedFormat === 'jpeg' && !hasJpegEndOfImage(fileBuffer)) {
    throw new Error('JPEG 图片缺少 EOI 结束标记，可能是 base64 截断或图片文件损坏');
  }

  if (detectedFormat === 'png' && !hasPngIend(fileBuffer)) {
    throw new Error('PNG 图片缺少 IEND 结束块，可能是 base64 截断或图片文件损坏');
  }

  return {
    ext,
    detectedFormat,
    contentType: detectedFormat === 'png' ? 'image/png' : 'image/jpeg',
  };
}

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
    if (fileBuffer.length > 1024 * 1024) {
      throw new Error('文件大小不能超过1MB');
    }

    // 检查文件格式。既检查后缀，也检查真实文件头，避免微信侧只返回笼统的 -1。
    const { ext, detectedFormat, contentType } = validateImageForUpload(actualFileName, fileBuffer);
    diagnostics = buildImageUploadDiagnostics(source, actualFileName, fileBuffer, ext, detectedFormat, contentType);

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
  description: '上传图文消息内所需的图片，不占用素材库限制',
  inputSchema: {
    filePath: z.string().optional().describe('图片文件路径（与fileData二选一）'),
    fileData: z.string().optional().describe('base64编码的图片数据（与filePath二选一）'),
    fileName: z.string().optional().describe('文件名（可选，默认从路径提取或使用image.jpg）')
  },
  handler: handleUploadImgTool
};
