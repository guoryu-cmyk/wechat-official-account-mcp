import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { WECHAT_UPLOADIMG_MAX_SIZE_BYTES } from './image-upload.js';
import {
  getImageUploadTempDir,
  saveUploadedImageToTemp,
  type SavedUploadedImage,
} from './image-temp-storage.js';

export const IMAGE_UPLOAD_CHUNK_BASE64_CHARS = 256 * 1024;
export const IMAGE_UPLOAD_MAX_CHUNK_BASE64_CHARS = 512 * 1024;
const CHUNK_SESSION_TTL_MS = 30 * 60 * 1000;

interface ChunkedImageUploadManifest {
  uploadId: string;
  fileName: string;
  createdAt: number;
  updatedAt: number;
  bytesReceived: number;
  nextChunkIndex: number;
  totalChunks?: number;
  totalSize?: number;
  expectedSha256?: string;
}

export interface StartedChunkedImageUpload {
  uploadId: string;
  fileName: string;
  chunkSizeBase64Chars: number;
  maxChunkBase64Chars: number;
  expiresAt: string;
}

export interface AppendedChunkedImageUpload {
  uploadId: string;
  chunkIndex: number;
  bytesReceived: number;
  nextChunkIndex: number;
}

export interface FinishedChunkedImageUpload extends SavedUploadedImage {
  uploadId: string;
  chunksReceived: number;
}

function getChunkSessionDir(): string {
  return path.join(getImageUploadTempDir(), '.chunks');
}

function getManifestPath(uploadId: string): string {
  return path.join(getChunkSessionDir(), `${uploadId}.json`);
}

function getPartPath(uploadId: string): string {
  return path.join(getChunkSessionDir(), `${uploadId}.part`);
}

function assertValidUploadId(uploadId: string): void {
  if (!/^[0-9a-f-]{36}$/.test(uploadId)) {
    throw new Error('uploadId 格式无效');
  }
}

function normalizeBase64Chunk(chunkData: string): string {
  const normalized = chunkData.replace(/\s/g, '');

  if (!normalized) {
    throw new Error('chunkData 不能为空');
  }

  if (normalized.length > IMAGE_UPLOAD_MAX_CHUNK_BASE64_CHARS) {
    throw new Error(`单个 base64 分片不能超过 ${IMAGE_UPLOAD_MAX_CHUNK_BASE64_CHARS} 个字符`);
  }

  if (normalized.length % 4 !== 0) {
    throw new Error('chunkData 长度必须是 4 的倍数，请按 base64 字符边界切分');
  }

  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error('chunkData 不是有效的 base64 分片');
  }

  return normalized;
}

async function readManifest(uploadId: string): Promise<ChunkedImageUploadManifest> {
  assertValidUploadId(uploadId);
  const manifestText = await fs.promises.readFile(getManifestPath(uploadId), 'utf8');
  return JSON.parse(manifestText) as ChunkedImageUploadManifest;
}

async function writeManifest(manifest: ChunkedImageUploadManifest): Promise<void> {
  await fs.promises.writeFile(getManifestPath(manifest.uploadId), JSON.stringify(manifest, null, 2), 'utf8');
}

/**
 * 清理超时的分片上传会话。
 *
 * 分片文件只用于把 ChatGPT 本地图片搬到 MCP 服务器临时目录，不应长期保留。
 */
export async function cleanupExpiredChunkedImageUploads(now = Date.now()): Promise<void> {
  const dir = getChunkSessionDir();
  if (!fs.existsSync(dir)) {
    return;
  }

  const entries = await fs.promises.readdir(dir);
  await Promise.all(entries
    .filter(entry => entry.endsWith('.json'))
    .map(async (entry) => {
      const manifestPath = path.join(dir, entry);
      try {
        const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')) as ChunkedImageUploadManifest;
        if (now - manifest.updatedAt <= CHUNK_SESSION_TTL_MS) {
          return;
        }

        await fs.promises.rm(getPartPath(manifest.uploadId), { force: true });
        await fs.promises.rm(manifestPath, { force: true });
      } catch {
        await fs.promises.rm(manifestPath, { force: true });
      }
    }));
}

/**
 * 创建一个 MCP 分片图片上传会话。
 */
export async function startChunkedImageUpload(input: {
  fileName: string;
  totalChunks?: number;
  totalSize?: number;
  expectedSha256?: string;
}): Promise<StartedChunkedImageUpload> {
  const fileName = path.basename(input.fileName || '').trim();
  if (!fileName) {
    throw new Error('fileName 不能为空');
  }

  if (input.totalSize && input.totalSize > WECHAT_UPLOADIMG_MAX_SIZE_BYTES) {
    throw new Error('文件大小不能超过1MB');
  }

  const uploadId = crypto.randomUUID();
  const now = Date.now();
  const manifest: ChunkedImageUploadManifest = {
    uploadId,
    fileName,
    createdAt: now,
    updatedAt: now,
    bytesReceived: 0,
    nextChunkIndex: 0,
    totalChunks: input.totalChunks,
    totalSize: input.totalSize,
    expectedSha256: input.expectedSha256,
  };

  await fs.promises.mkdir(getChunkSessionDir(), { recursive: true });
  await cleanupExpiredChunkedImageUploads(now);
  await fs.promises.writeFile(getPartPath(uploadId), Buffer.alloc(0), { flag: 'wx' });
  await writeManifest(manifest);

  return {
    uploadId,
    fileName,
    chunkSizeBase64Chars: IMAGE_UPLOAD_CHUNK_BASE64_CHARS,
    maxChunkBase64Chars: IMAGE_UPLOAD_MAX_CHUNK_BASE64_CHARS,
    expiresAt: new Date(now + CHUNK_SESSION_TTL_MS).toISOString(),
  };
}

/**
 * 追加一个 base64 分片。分片必须按 chunkIndex 从 0 开始顺序追加。
 */
export async function appendChunkedImageUpload(input: {
  uploadId: string;
  chunkIndex: number;
  chunkData: string;
}): Promise<AppendedChunkedImageUpload> {
  const manifest = await readManifest(input.uploadId);

  if (input.chunkIndex !== manifest.nextChunkIndex) {
    throw new Error(`chunkIndex 顺序错误，期望 ${manifest.nextChunkIndex}，实际 ${input.chunkIndex}`);
  }

  const normalized = normalizeBase64Chunk(input.chunkData);
  const buffer = Buffer.from(normalized, 'base64');
  if (buffer.length === 0) {
    throw new Error('chunkData 解码后为空');
  }

  const nextBytesReceived = manifest.bytesReceived + buffer.length;
  if (nextBytesReceived > WECHAT_UPLOADIMG_MAX_SIZE_BYTES) {
    throw new Error('文件大小不能超过1MB');
  }

  await fs.promises.appendFile(getPartPath(manifest.uploadId), buffer);

  manifest.bytesReceived = nextBytesReceived;
  manifest.nextChunkIndex += 1;
  manifest.updatedAt = Date.now();
  await writeManifest(manifest);

  return {
    uploadId: manifest.uploadId,
    chunkIndex: input.chunkIndex,
    bytesReceived: manifest.bytesReceived,
    nextChunkIndex: manifest.nextChunkIndex,
  };
}

/**
 * 完成 MCP 分片上传，校验图片并保存到正式临时目录。
 */
export async function finishChunkedImageUpload(uploadId: string): Promise<FinishedChunkedImageUpload> {
  const manifest = await readManifest(uploadId);

  if (manifest.totalChunks !== undefined && manifest.nextChunkIndex !== manifest.totalChunks) {
    throw new Error(`分片数量不完整，期望 ${manifest.totalChunks}，实际 ${manifest.nextChunkIndex}`);
  }

  if (manifest.totalSize !== undefined && manifest.bytesReceived !== manifest.totalSize) {
    throw new Error(`文件大小不一致，期望 ${manifest.totalSize} 字节，实际 ${manifest.bytesReceived} 字节`);
  }

  const partPath = getPartPath(manifest.uploadId);
  const buffer = await fs.promises.readFile(partPath);

  if (manifest.expectedSha256) {
    const actualSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    if (actualSha256 !== manifest.expectedSha256) {
      throw new Error(`sha256 校验失败，期望 ${manifest.expectedSha256}，实际 ${actualSha256}`);
    }
  }

  const saved = await saveUploadedImageToTemp({
    buffer,
    originalName: manifest.fileName,
  });

  await abortChunkedImageUpload(manifest.uploadId);

  return {
    ...saved,
    uploadId: manifest.uploadId,
    chunksReceived: manifest.nextChunkIndex,
  };
}

/**
 * 取消分片上传并删除会话文件。
 */
export async function abortChunkedImageUpload(uploadId: string): Promise<void> {
  assertValidUploadId(uploadId);
  await Promise.all([
    fs.promises.rm(getPartPath(uploadId), { force: true }),
    fs.promises.rm(getManifestPath(uploadId), { force: true }),
  ]);
}
