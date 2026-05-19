import path from 'path';

export type SupportedImageFormat = 'jpeg' | 'png';

export const WECHAT_UPLOADIMG_MAX_SIZE_BYTES = 1024 * 1024;

export interface ImageUploadDiagnostics {
  source: 'filePath' | 'fileData' | 'multipart';
  fileName: string;
  size: number;
  extension: string;
  detectedFormat: SupportedImageFormat | 'unknown';
  contentType: string;
  magicHead: string;
  magicTail: string;
  jpegHasEoi?: boolean;
  pngHasIend?: boolean;
  multipartField: 'media' | 'file';
  endpoint: '/cgi-bin/media/uploadimg' | '/upload-image';
}

/**
 * 将 fileData 解码为图片 Buffer。
 *
 * ChatGPT 等客户端有时会传 data:image/...;base64, 前缀，或者在 base64
 * 中插入换行。这里统一剥离前缀和空白字符；但不会在日志里输出原始 base64，
 * 避免大日志和敏感内容泄露。
 */
export function decodeBase64ImageData(fileData: string): Buffer {
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
export function getFormatFromExtension(ext: string): SupportedImageFormat | undefined {
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
export function detectImageFormat(buffer: Buffer): SupportedImageFormat | 'unknown' {
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
export function hasJpegEndOfImage(buffer: Buffer): boolean {
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
export function hasPngIend(buffer: Buffer): boolean {
  return buffer.length >= 12
    && buffer.subarray(buffer.length - 12).toString('hex') === '0000000049454e44ae426082';
}

export function getContentTypeForImageFormat(format: SupportedImageFormat): string {
  return format === 'png' ? 'image/png' : 'image/jpeg';
}

export function getExtensionForImageFormat(format: SupportedImageFormat): string {
  return format === 'png' ? '.png' : '.jpg';
}

/**
 * 校验图片 Buffer 是否是完整的 jpg/png。
 */
export function validateImageBuffer(fileBuffer: Buffer): {
  detectedFormat: SupportedImageFormat;
  contentType: string;
} {
  const detectedFormat = detectImageFormat(fileBuffer);
  if (detectedFormat === 'unknown') {
    const magicHead = fileBuffer.subarray(0, 12).toString('hex') || 'empty';
    throw new Error(`图片内容不是有效的 jpg/png，文件头: ${magicHead}`);
  }

  if (detectedFormat === 'jpeg' && !hasJpegEndOfImage(fileBuffer)) {
    throw new Error('JPEG 图片缺少 EOI 结束标记，可能是 base64 截断或图片文件损坏');
  }

  if (detectedFormat === 'png' && !hasPngIend(fileBuffer)) {
    throw new Error('PNG 图片缺少 IEND 结束块，可能是 base64 截断或图片文件损坏');
  }

  return {
    detectedFormat,
    contentType: getContentTypeForImageFormat(detectedFormat),
  };
}

/**
 * 校验文件名后缀与真实图片内容是否一致，并返回微信上传所需的 Content-Type。
 */
export function validateImageForUpload(fileName: string, fileBuffer: Buffer): {
  ext: string;
  detectedFormat: SupportedImageFormat;
  contentType: string;
} {
  const ext = path.extname(fileName).toLowerCase();
  const expectedFormat = getFormatFromExtension(ext);

  if (!expectedFormat) {
    throw new Error('仅支持 jpg/png 格式的图片');
  }

  const { detectedFormat, contentType } = validateImageBuffer(fileBuffer);

  if (detectedFormat !== expectedFormat) {
    throw new Error(`文件名后缀为 ${ext}，但图片内容识别为 ${detectedFormat}，请修正 fileName 或图片内容`);
  }

  return {
    ext,
    detectedFormat,
    contentType,
  };
}

/**
 * 构建图片上传诊断信息。
 *
 * 诊断只包含元数据和魔数，不包含图片正文/base64，便于线上安全排查。
 */
export function buildImageUploadDiagnostics(
  source: ImageUploadDiagnostics['source'],
  fileName: string,
  fileBuffer: Buffer,
  ext: string,
  detectedFormat: SupportedImageFormat | 'unknown',
  contentType: string,
  multipartField: ImageUploadDiagnostics['multipartField'],
  endpoint: ImageUploadDiagnostics['endpoint'],
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
    multipartField,
    endpoint,
  };

  if (detectedFormat === 'jpeg') {
    diagnostics.jpegHasEoi = hasJpegEndOfImage(fileBuffer);
  }

  if (detectedFormat === 'png') {
    diagnostics.pngHasIend = hasPngIend(fileBuffer);
  }

  return diagnostics;
}
