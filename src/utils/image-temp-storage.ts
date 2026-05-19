import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildImageUploadDiagnostics,
  getExtensionForImageFormat,
  validateImageBuffer,
  WECHAT_UPLOADIMG_MAX_SIZE_BYTES,
  type ImageUploadDiagnostics,
} from './image-upload.js';

export interface SaveUploadedImageInput {
  buffer: Buffer;
  originalName?: string;
}

export interface SavedUploadedImage {
  filePath: string;
  fileName: string;
  originalName?: string;
  size: number;
  detectedFormat: ImageUploadDiagnostics['detectedFormat'];
  contentType: string;
  diagnostics: ImageUploadDiagnostics;
}

/**
 * 返回图片上传接口的默认临时目录。
 *
 * 默认写到 ~/wechat-official-account-mcp/temp，方便远程服务器上手工查看和清理。
 * 如需测试或特殊部署，可用 WECHAT_MCP_IMAGE_UPLOAD_DIR 覆盖。
 */
export function getImageUploadTempDir(): string {
  if (process.env.WECHAT_MCP_IMAGE_UPLOAD_DIR) {
    return path.resolve(process.env.WECHAT_MCP_IMAGE_UPLOAD_DIR);
  }

  return path.join(os.homedir(), 'wechat-official-account-mcp', 'temp');
}

/**
 * 清理原始文件名，只保留可安全落盘和展示的片段。
 */
function sanitizeUploadBaseName(originalName: string | undefined): string {
  const baseName = path.basename(originalName || 'image');
  const parsed = path.parse(baseName);
  const normalized = parsed.name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  return normalized || 'image';
}

/**
 * 保存已经进入 MCP 服务器进程的图片二进制。
 *
 * 这里统一校验图片大小、真实格式和完整性，再写入临时目录；无论图片来自
 * HTTP multipart 还是 MCP 分片上传，都复用同一套安全边界。
 */
export async function saveUploadedImageToTemp(input: SaveUploadedImageInput): Promise<SavedUploadedImage> {
  const { buffer, originalName } = input;

  if (!buffer || buffer.length === 0) {
    throw new Error('上传图片不能为空');
  }

  if (buffer.length > WECHAT_UPLOADIMG_MAX_SIZE_BYTES) {
    throw new Error('文件大小不能超过1MB');
  }

  const { detectedFormat, contentType } = validateImageBuffer(buffer);
  const ext = getExtensionForImageFormat(detectedFormat);
  const fileName = `${Date.now()}-${crypto.randomUUID()}-${sanitizeUploadBaseName(originalName)}${ext}`;
  const uploadDir = getImageUploadTempDir();
  const filePath = path.join(uploadDir, fileName);
  const diagnostics = buildImageUploadDiagnostics(
    'multipart',
    fileName,
    buffer,
    ext,
    detectedFormat,
    contentType,
    'file',
    '/upload-image',
  );

  await fs.promises.mkdir(uploadDir, { recursive: true });
  await fs.promises.writeFile(filePath, buffer, { flag: 'wx' });

  return {
    filePath,
    fileName,
    originalName,
    size: buffer.length,
    detectedFormat,
    contentType,
    diagnostics,
  };
}
