import axios from 'axios';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import FormData from 'form-data';
import { WechatApiClient } from '../wechat/api-client.js';
import { logger } from './logger.js';
import {
  getExtensionForImageFormat,
  validateImageForUpload,
  WECHAT_UPLOADIMG_MAX_SIZE_BYTES,
} from './image-upload.js';

export type ChatGPTAssetRole = 'inline' | 'cover';

export interface ChatGPTFileRef {
  file_id?: string;
  download_url: string;
  file_name?: string;
  mime_type?: string;
}

export interface ChatGPTAssetManifestItem {
  id: string;
  path: string;
  role: ChatGPTAssetRole;
  sha256?: string;
}

export interface ChatGPTArticleManifest {
  topicSlug?: string;
  article: string;
  title?: string;
  author?: string;
  digest?: string;
  contentSourceUrl?: string;
  showCoverPic?: number;
  images: ChatGPTAssetManifestItem[];
}

export interface ChatGPTWorkspaceAsset {
  id: string;
  role: ChatGPTAssetRole;
  sourcePath: string;
  sha256: string;
  fileName: string;
  size: number;
  wechatUrl?: string;
  mediaId?: string;
  status: 'uploaded' | 'replaced' | 'reused';
}

export interface ChatGPTWorkspaceRecord {
  directoryId: string;
  topicSlug: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  sourceFileName?: string;
}

export interface ChatGPTWorkspaceResult {
  ok: true;
  directoryId: string;
  topicSlug: string;
  revision: number;
  baseDir: string;
  workspaceDir: string;
  articleHtml?: string;
  articleMarkdown?: string;
  draftArticle?: {
    title: string;
    author?: string;
    digest?: string;
    content: string;
    contentSourceUrl?: string;
    thumbMediaId?: string;
    showCoverPic?: number;
  };
  inlineImages: ChatGPTWorkspaceAsset[];
  cover?: ChatGPTWorkspaceAsset;
  assets: ChatGPTWorkspaceAsset[];
  failed: Array<{
    id?: string;
    sourcePath?: string;
    message: string;
  }>;
  nextTool?: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

const DEFAULT_CHATGPT_ASSETS_BASE = '~/wechat-official-account-mcp/temp/chatgpt';
const DEFAULT_MAX_ZIP_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_UNZIPPED_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_ZIP_FILES = 200;

const WORKSPACE_FILE = 'workspace.json';
const WECHAT_ASSETS_FILE = 'wechat-assets.json';

type ExtractedZipEntry = {
  relativePath: string;
  data: Buffer;
};

function expandHome(input: string): string {
  if (input === '~') {
    return os.homedir();
  }

  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }

  return input;
}

export function getChatGPTAssetsBaseDir(): string {
  const configured = process.env.CHATGPT_ASSETS_BASE_DIR || DEFAULT_CHATGPT_ASSETS_BASE;
  return path.resolve(expandHome(configured));
}

function getMaxZipBytes(): number {
  return Number(process.env.CHATGPT_ASSETS_MAX_ZIP_BYTES || DEFAULT_MAX_ZIP_BYTES);
}

function getMaxUnzippedBytes(): number {
  return Number(process.env.CHATGPT_ASSETS_MAX_UNZIPPED_BYTES || DEFAULT_MAX_UNZIPPED_BYTES);
}

function getMaxZipFiles(): number {
  return Number(process.env.CHATGPT_ASSETS_MAX_ZIP_FILES || DEFAULT_MAX_ZIP_FILES);
}

function nowIso(): string {
  return new Date().toISOString();
}

function createDirectoryId(): string {
  return `cwk_${Date.now().toString(36)}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function assertValidDirectoryId(directoryId: string): void {
  if (!/^cwk_[a-z0-9_]{12,80}$/.test(directoryId)) {
    throw new Error('directoryId 格式无效，请使用 MCP 返回的不透明目录 ID');
  }
}

function normalizeTopicSlug(input?: string): string {
  const normalized = (input || 'chatgpt-article')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

  return normalized.length >= 3 ? normalized : 'chatgpt-article';
}

function assertSafeAssetId(assetId: string): void {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(assetId)) {
    throw new Error(`asset id 无效: ${assetId}`);
  }
}

function normalizeZipPath(relativePath: string): string {
  const normalized = path.posix.normalize(relativePath);

  if (
    !relativePath ||
    relativePath.includes('\\') ||
    normalized.startsWith('../') ||
    normalized === '..' ||
    normalized.startsWith('/') ||
    path.win32.isAbsolute(relativePath)
  ) {
    throw new Error(`ZIP 内存在不安全路径: ${relativePath}`);
  }

  return normalized;
}

function safeJoin(root: string, relativePath: string): string {
  const target = path.resolve(root, ...normalizeZipPath(relativePath).split('/'));
  const relative = path.relative(root, target);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`路径越界: ${relativePath}`);
  }

  return target;
}

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function readUInt16(buffer: Buffer, offset: number): number {
  if (offset + 2 > buffer.length) {
    throw new Error('ZIP 文件结构损坏');
  }

  return buffer.readUInt16LE(offset);
}

function readUInt32(buffer: Buffer, offset: number): number {
  if (offset + 4 > buffer.length) {
    throw new Error('ZIP 文件结构损坏');
  }

  return buffer.readUInt32LE(offset);
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minOffset = Math.max(0, buffer.length - 22 - 65535);

  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (readUInt32(buffer, offset) === 0x06054b50) {
      return offset;
    }
  }

  throw new Error('ZIP 文件缺少中央目录，可能不是有效 zip');
}

function shouldIgnoreZipEntry(relativePath: string): boolean {
  const lowerPath = relativePath.toLowerCase();
  return (
    lowerPath.endsWith('/') ||
    lowerPath === '.ds_store' ||
    lowerPath.endsWith('/.ds_store') ||
    lowerPath.startsWith('__macosx/')
  );
}

/**
 * 解压标准 ZIP 的最小实现。
 *
 * 这里不依赖系统 unzip 或第三方包，避免部署环境额外安装依赖。只支持常见的 store/deflate，
 * 并在解压前后限制文件数量、总大小和路径，防止 zip slip 与压缩炸弹。
 */
function extractZipEntries(zipBuffer: Buffer): ExtractedZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(zipBuffer);
  const totalEntries = readUInt16(zipBuffer, eocdOffset + 10);
  const centralDirectoryOffset = readUInt32(zipBuffer, eocdOffset + 16);
  const maxFiles = getMaxZipFiles();
  const maxUnzippedBytes = getMaxUnzippedBytes();

  if (totalEntries > maxFiles) {
    throw new Error(`ZIP 文件数量过多，最多允许 ${maxFiles} 个文件`);
  }

  let offset = centralDirectoryOffset;
  let totalUnzippedBytes = 0;
  const entries: ExtractedZipEntry[] = [];

  for (let index = 0; index < totalEntries; index += 1) {
    if (readUInt32(zipBuffer, offset) !== 0x02014b50) {
      throw new Error('ZIP 中央目录结构损坏');
    }

    const flags = readUInt16(zipBuffer, offset + 8);
    const compressionMethod = readUInt16(zipBuffer, offset + 10);
    const compressedSize = readUInt32(zipBuffer, offset + 20);
    const uncompressedSize = readUInt32(zipBuffer, offset + 24);
    const fileNameLength = readUInt16(zipBuffer, offset + 28);
    const extraLength = readUInt16(zipBuffer, offset + 30);
    const commentLength = readUInt16(zipBuffer, offset + 32);
    const localHeaderOffset = readUInt32(zipBuffer, offset + 42);
    const rawName = zipBuffer.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8');
    const relativePath = normalizeZipPath(rawName);

    offset += 46 + fileNameLength + extraLength + commentLength;

    if (shouldIgnoreZipEntry(relativePath)) {
      continue;
    }

    if ((flags & 0x01) !== 0) {
      throw new Error(`不支持加密 ZIP 条目: ${relativePath}`);
    }

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error(`暂不支持 ZIP64 条目: ${relativePath}`);
    }

    totalUnzippedBytes += uncompressedSize;
    if (totalUnzippedBytes > maxUnzippedBytes) {
      throw new Error(`ZIP 解压后体积过大，最多允许 ${maxUnzippedBytes} 字节`);
    }

    if (readUInt32(zipBuffer, localHeaderOffset) !== 0x04034b50) {
      throw new Error(`ZIP 本地文件头损坏: ${relativePath}`);
    }

    const localNameLength = readUInt16(zipBuffer, localHeaderOffset + 26);
    const localExtraLength = readUInt16(zipBuffer, localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressedData = zipBuffer.subarray(dataStart, dataStart + compressedSize);

    let data: Buffer;
    if (compressionMethod === 0) {
      data = Buffer.from(compressedData);
    } else if (compressionMethod === 8) {
      data = zlib.inflateRawSync(compressedData);
    } else {
      throw new Error(`不支持的 ZIP 压缩方式 ${compressionMethod}: ${relativePath}`);
    }

    if (data.length !== uncompressedSize) {
      throw new Error(`ZIP 条目大小校验失败: ${relativePath}`);
    }

    entries.push({ relativePath, data });
  }

  return entries;
}

async function writeExtractedEntries(root: string, entries: ExtractedZipEntry[]): Promise<void> {
  for (const entry of entries) {
    const target = safeJoin(root, entry.relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, entry.data);
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  const text = await fs.readFile(filePath, 'utf8');
  return JSON.parse(text) as T;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function downloadChatGPTFile(file: ChatGPTFileRef, maxBytes: number): Promise<Buffer> {
  const downloadUrl = new URL(file.download_url);
  if (downloadUrl.protocol !== 'https:') {
    throw new Error('ChatGPT 文件 download_url 必须是 HTTPS');
  }

  const response = await axios.get<ArrayBuffer>(downloadUrl.toString(), {
    responseType: 'arraybuffer',
    timeout: 30000,
    maxRedirects: 3,
    maxContentLength: maxBytes,
    maxBodyLength: maxBytes,
    validateStatus: status => status >= 200 && status < 300,
  });

  const buffer = Buffer.from(response.data);
  if (buffer.length > maxBytes) {
    throw new Error(`下载文件过大，最多允许 ${maxBytes} 字节`);
  }

  return buffer;
}

function validateManifest(rawManifest: ChatGPTArticleManifest): ChatGPTArticleManifest {
  if (!rawManifest.article) {
    throw new Error('manifest.json 缺少 article 字段');
  }

  if (!Array.isArray(rawManifest.images) || rawManifest.images.length === 0) {
    throw new Error('manifest.json 至少需要声明一张图片');
  }

  const ids = new Set<string>();
  for (const image of rawManifest.images) {
    assertSafeAssetId(image.id);
    if (ids.has(image.id)) {
      throw new Error(`manifest.json 存在重复图片 id: ${image.id}`);
    }

    ids.add(image.id);
    normalizeZipPath(image.path);

    if (image.role !== 'inline' && image.role !== 'cover') {
      throw new Error(`图片 ${image.id} 的 role 只能是 inline 或 cover`);
    }

    if (image.sha256 && !/^[a-f0-9]{64}$/i.test(image.sha256)) {
      throw new Error(`图片 ${image.id} 的 sha256 格式无效`);
    }
  }

  const coverImages = rawManifest.images.filter(image => image.role === 'cover');
  if (coverImages.length !== 1) {
    throw new Error('manifest.json 必须且只能声明一张 role=cover 的封面图，用于草稿 thumbMediaId');
  }

  return rawManifest;
}

function collectArticleAssetIds(articleText: string): Set<string> {
  const ids = new Set<string>();
  const matcher = /asset:\/\/image\/([a-zA-Z0-9_-]+)/g;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(articleText)) !== null) {
    ids.add(match[1]);
  }

  return ids;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function markdownToHtml(markdown: string): string {
  const blocks = markdown.split(/\n{2,}/);

  return blocks
    .map(block => {
      const trimmed = block.trim();
      if (!trimmed) {
        return '';
      }

      const imageOnly = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      if (imageOnly) {
        return `<p><img src="${escapeHtml(imageOnly[2])}" alt="${escapeHtml(imageOnly[1])}" /></p>`;
      }

      if (trimmed.startsWith('### ')) {
        return `<h3>${escapeHtml(trimmed.slice(4))}</h3>`;
      }

      if (trimmed.startsWith('## ')) {
        return `<h2>${escapeHtml(trimmed.slice(3))}</h2>`;
      }

      if (trimmed.startsWith('# ')) {
        return `<h1>${escapeHtml(trimmed.slice(2))}</h1>`;
      }

      const inlineImageReplaced = escapeHtml(trimmed).replace(
        /!\[([^\]]*)\]\((asset:\/\/image\/[a-zA-Z0-9_-]+)\)/g,
        (_all, alt, src) => `<img src="${src}" alt="${escapeHtml(alt)}" />`,
      );

      return `<p>${inlineImageReplaced.replace(/\n/g, '<br />')}</p>`;
    })
    .filter(Boolean)
    .join('\n');
}

function replaceArticleAssetRefs(articleHtml: string, assets: ChatGPTWorkspaceAsset[]): string {
  let replaced = articleHtml;

  for (const asset of assets) {
    if (!asset.wechatUrl) {
      continue;
    }

    const escapedId = asset.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    replaced = replaced.replace(new RegExp(`asset://image/${escapedId}`, 'g'), asset.wechatUrl);
  }

  return replaced;
}

async function uploadArticleImage(
  apiClient: WechatApiClient,
  buffer: Buffer,
  fileName: string,
): Promise<{ url: string; fileName: string; contentType: string }> {
  if (buffer.length > WECHAT_UPLOADIMG_MAX_SIZE_BYTES) {
    throw new Error(`${fileName} 超过微信公众号正文图片 1MB 限制`);
  }

  const { detectedFormat, contentType } = validateImageForUpload(fileName, buffer);
  const formData = new FormData();
  formData.append('media', buffer, {
    filename: fileName,
    contentType,
  });

  const response = await apiClient.uploadImg(formData) as any;
  if (response.errcode && response.errcode !== 0) {
    throw new Error(`微信 uploadimg 失败: ${response.errmsg} (${response.errcode})`);
  }

  return {
    url: response.url,
    fileName,
    contentType: contentType || (detectedFormat === 'png' ? 'image/png' : 'image/jpeg'),
  };
}

async function uploadPermanentCoverImage(
  apiClient: WechatApiClient,
  buffer: Buffer,
  fileName: string,
): Promise<{ mediaId: string; url?: string }> {
  const { contentType } = validateImageForUpload(fileName, buffer);
  const formData = new FormData();
  formData.append('media', buffer, {
    filename: fileName,
    contentType,
  });

  const response = await apiClient.uploadPermanentMaterial('image', formData) as any;

  return {
    mediaId: response.media_id,
    url: response.url,
  };
}

function getWorkspaceDir(directoryId: string): string {
  assertValidDirectoryId(directoryId);
  return path.join(getChatGPTAssetsBaseDir(), directoryId);
}

async function readWorkspaceRecord(directoryId: string): Promise<ChatGPTWorkspaceRecord | undefined> {
  const workspacePath = path.join(getWorkspaceDir(directoryId), WORKSPACE_FILE);
  if (!await fileExists(workspacePath)) {
    return undefined;
  }

  return readJson<ChatGPTWorkspaceRecord>(workspacePath);
}

async function readWorkspaceAssets(directoryId: string): Promise<ChatGPTWorkspaceAsset[]> {
  const assetsPath = path.join(getWorkspaceDir(directoryId), WECHAT_ASSETS_FILE);
  if (!await fileExists(assetsPath)) {
    return [];
  }

  const parsed = await readJson<{ assets?: ChatGPTWorkspaceAsset[] }>(assetsPath);
  return parsed.assets || [];
}

async function promoteStagingDirectory(stagingDir: string, workspaceDir: string): Promise<void> {
  const baseDir = getChatGPTAssetsBaseDir();
  const backupDir = path.join(baseDir, '.backup', `${path.basename(workspaceDir)}-${Date.now()}`);
  const hasExistingWorkspace = await fileExists(workspaceDir);

  await fs.mkdir(baseDir, { recursive: true });
  await fs.mkdir(path.dirname(backupDir), { recursive: true });

  if (hasExistingWorkspace) {
    await fs.rename(workspaceDir, backupDir);
  }

  try {
    await fs.rename(stagingDir, workspaceDir);
    if (hasExistingWorkspace) {
      await fs.rm(backupDir, { recursive: true, force: true });
    }
  } catch (error) {
    if (hasExistingWorkspace && await fileExists(backupDir)) {
      await fs.rename(backupDir, workspaceDir);
    }

    throw error;
  }
}

async function processManifestImages(
  apiClient: WechatApiClient,
  rootDir: string,
  manifest: ChatGPTArticleManifest,
  referencedAssetIds: Set<string>,
): Promise<{
  assets: ChatGPTWorkspaceAsset[];
  failed: ChatGPTWorkspaceResult['failed'];
}> {
  const assets: ChatGPTWorkspaceAsset[] = [];
  const failed: ChatGPTWorkspaceResult['failed'] = [];

  for (const image of manifest.images) {
    const imagePath = safeJoin(rootDir, image.path);
    if (!await fileExists(imagePath)) {
      failed.push({ id: image.id, sourcePath: image.path, message: 'manifest 声明的图片文件不存在' });
      continue;
    }

    try {
      const buffer = await fs.readFile(imagePath);
      const actualSha256 = sha256(buffer);

      if (image.sha256 && image.sha256.toLowerCase() !== actualSha256) {
        throw new Error(`sha256 不匹配，期望 ${image.sha256}，实际 ${actualSha256}`);
      }

      const { detectedFormat } = validateImageForUpload(path.basename(image.path), buffer);
      const ext = getExtensionForImageFormat(detectedFormat);
      const uploadFileName = path.extname(image.path)
        ? path.basename(image.path)
        : `${image.id}${ext}`;
      const asset: ChatGPTWorkspaceAsset = {
        id: image.id,
        role: image.role,
        sourcePath: image.path,
        sha256: actualSha256,
        fileName: uploadFileName,
        size: buffer.length,
        status: 'uploaded',
      };

      if (image.role === 'inline' || referencedAssetIds.has(image.id)) {
        const uploaded = await uploadArticleImage(apiClient, buffer, uploadFileName);
        asset.wechatUrl = uploaded.url;
      }

      if (image.role === 'cover') {
        const uploadedCover = await uploadPermanentCoverImage(apiClient, buffer, uploadFileName);
        asset.mediaId = uploadedCover.mediaId;
      }

      assets.push(asset);
    } catch (error) {
      failed.push({
        id: image.id,
        sourcePath: image.path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { assets, failed };
}

function assertAllArticleRefsDeclared(articleText: string, manifest: ChatGPTArticleManifest): void {
  const manifestIds = new Set(manifest.images.map(image => image.id));
  const referencedIds = collectArticleAssetIds(articleText);

  for (const referencedId of referencedIds) {
    if (!manifestIds.has(referencedId)) {
      throw new Error(`正文引用了 manifest 中不存在的图片 id: ${referencedId}`);
    }
  }
}

function buildDraftArticle(
  manifest: ChatGPTArticleManifest,
  articleHtml: string,
  cover?: ChatGPTWorkspaceAsset,
): ChatGPTWorkspaceResult['draftArticle'] | undefined {
  if (!manifest.title) {
    return undefined;
  }

  return {
    title: manifest.title,
    author: manifest.author,
    digest: manifest.digest,
    content: articleHtml,
    contentSourceUrl: manifest.contentSourceUrl,
    thumbMediaId: cover?.mediaId,
    showCoverPic: manifest.showCoverPic ?? 0,
  };
}

async function loadArticleText(rootDir: string, manifest: ChatGPTArticleManifest): Promise<{
  source: string;
  markdown?: string;
  html: string;
}> {
  const articlePath = safeJoin(rootDir, manifest.article);
  if (!await fileExists(articlePath)) {
    throw new Error(`manifest.article 指向的文章文件不存在: ${manifest.article}`);
  }

  const source = await fs.readFile(articlePath, 'utf8');
  const ext = path.extname(manifest.article).toLowerCase();

  if (ext === '.html' || ext === '.htm') {
    return { source, html: source };
  }

  return {
    source,
    markdown: source,
    html: markdownToHtml(source),
  };
}

async function saveWorkspaceFiles(
  workspaceDir: string,
  workspace: ChatGPTWorkspaceRecord,
  manifest: ChatGPTArticleManifest,
  assets: ChatGPTWorkspaceAsset[],
  articleHtml?: string,
): Promise<void> {
  await writeJson(path.join(workspaceDir, WORKSPACE_FILE), workspace);
  await writeJson(path.join(workspaceDir, 'manifest.normalized.json'), manifest);
  await writeJson(path.join(workspaceDir, WECHAT_ASSETS_FILE), {
    directoryId: workspace.directoryId,
    topicSlug: workspace.topicSlug,
    revision: workspace.revision,
    updatedAt: workspace.updatedAt,
    assets,
  });

  if (articleHtml) {
    await fs.writeFile(path.join(workspaceDir, 'article.wechat.html'), articleHtml, 'utf8');
  }
}

export async function processArticleBundleFromChatGPTFile(input: {
  directoryId?: string;
  topicSlug?: string;
  bundle: ChatGPTFileRef;
}, apiClient: WechatApiClient): Promise<ChatGPTWorkspaceResult> {
  const baseDir = getChatGPTAssetsBaseDir();
  const directoryId = input.directoryId || createDirectoryId();
  assertValidDirectoryId(directoryId);

  const existingWorkspace = await readWorkspaceRecord(directoryId);
  const topicSlug = normalizeTopicSlug(input.topicSlug || existingWorkspace?.topicSlug);
  const revision = (existingWorkspace?.revision || 0) + 1;
  const workspaceDir = getWorkspaceDir(directoryId);
  const stagingDir = path.join(baseDir, '.staging', `${directoryId}-${Date.now()}-${crypto.randomUUID()}`);

  await fs.mkdir(stagingDir, { recursive: true });

  try {
    const zipBuffer = await downloadChatGPTFile(input.bundle, getMaxZipBytes());
    const entries = extractZipEntries(zipBuffer);
    await writeExtractedEntries(stagingDir, entries);

    const manifestPath = path.join(stagingDir, 'manifest.json');
    if (!await fileExists(manifestPath)) {
      throw new Error('ZIP 根目录必须包含 manifest.json');
    }

    const manifest = validateManifest(await readJson<ChatGPTArticleManifest>(manifestPath));
    manifest.topicSlug = topicSlug;

    const article = await loadArticleText(stagingDir, manifest);
    assertAllArticleRefsDeclared(article.source, manifest);

    const referencedAssetIds = collectArticleAssetIds(article.source);
    const { assets, failed } = await processManifestImages(apiClient, stagingDir, manifest, referencedAssetIds);

    if (failed.length > 0) {
      throw new Error(`素材上传失败: ${failed.map(item => `${item.id || item.sourcePath}: ${item.message}`).join('; ')}`);
    }

    const articleHtml = replaceArticleAssetRefs(article.html, assets);
    const cover = assets.find(asset => asset.role === 'cover');
    const inlineImages = assets.filter(asset => asset.wechatUrl);
    const workspace: ChatGPTWorkspaceRecord = {
      directoryId,
      topicSlug,
      revision,
      createdAt: existingWorkspace?.createdAt || nowIso(),
      updatedAt: nowIso(),
      sourceFileName: input.bundle.file_name,
    };
    const draftArticle = buildDraftArticle(manifest, articleHtml, cover);

    await saveWorkspaceFiles(stagingDir, workspace, manifest, assets, articleHtml);
    await promoteStagingDirectory(stagingDir, workspaceDir);

    return {
      ok: true,
      directoryId,
      topicSlug,
      revision,
      baseDir,
      workspaceDir,
      articleHtml,
      articleMarkdown: article.markdown,
      draftArticle,
      inlineImages,
      cover,
      assets,
      failed: [],
      nextTool: draftArticle?.thumbMediaId
        ? {
            name: 'wechat_draft',
            arguments: {
              action: 'add',
              articles: [draftArticle],
            },
          }
        : undefined,
    };
  } catch (error) {
    await fs.rm(stagingDir, { recursive: true, force: true });
    logger.error('Failed to process ChatGPT article bundle', {
      directoryId,
      topicSlug,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function uploadWorkspaceImageFromChatGPTFile(input: {
  directoryId: string;
  assetId: string;
  role: ChatGPTAssetRole;
  file: ChatGPTFileRef;
}, apiClient: WechatApiClient): Promise<ChatGPTWorkspaceResult> {
  assertValidDirectoryId(input.directoryId);
  assertSafeAssetId(input.assetId);

  const workspace = await readWorkspaceRecord(input.directoryId);
  if (!workspace) {
    throw new Error(`目录不存在: ${input.directoryId}`);
  }

  const workspaceDir = getWorkspaceDir(input.directoryId);
  const buffer = await downloadChatGPTFile(input.file, WECHAT_UPLOADIMG_MAX_SIZE_BYTES);
  const originalFileName = input.file.file_name || `${input.assetId}.png`;
  const { detectedFormat } = validateImageForUpload(originalFileName, buffer);
  const ext = getExtensionForImageFormat(detectedFormat);
  const targetRelativePath = `images/${input.assetId}${ext}`;
  const targetPath = safeJoin(workspaceDir, targetRelativePath);
  const nextRevision = workspace.revision + 1;
  const existingAssets = await readWorkspaceAssets(input.directoryId);
  const nextAsset: ChatGPTWorkspaceAsset = {
    id: input.assetId,
    role: input.role,
    sourcePath: targetRelativePath,
    sha256: sha256(buffer),
    fileName: path.basename(targetRelativePath),
    size: buffer.length,
    status: existingAssets.some(asset => asset.id === input.assetId) ? 'replaced' : 'uploaded',
  };

  if (input.role === 'inline') {
    const uploaded = await uploadArticleImage(apiClient, buffer, nextAsset.fileName);
    nextAsset.wechatUrl = uploaded.url;
  } else {
    const uploadedCover = await uploadPermanentCoverImage(apiClient, buffer, nextAsset.fileName);
    nextAsset.mediaId = uploadedCover.mediaId;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, buffer);

  const assets = [
    ...existingAssets.filter(asset => asset.id !== input.assetId),
    nextAsset,
  ];
  const updatedWorkspace = {
    ...workspace,
    revision: nextRevision,
    updatedAt: nowIso(),
  };

  await writeJson(path.join(workspaceDir, WORKSPACE_FILE), updatedWorkspace);
  await writeJson(path.join(workspaceDir, WECHAT_ASSETS_FILE), {
    directoryId: input.directoryId,
    topicSlug: workspace.topicSlug,
    revision: nextRevision,
    updatedAt: updatedWorkspace.updatedAt,
    assets,
  });

  return {
    ok: true,
    directoryId: input.directoryId,
    topicSlug: workspace.topicSlug,
    revision: nextRevision,
    baseDir: getChatGPTAssetsBaseDir(),
    workspaceDir,
    inlineImages: assets.filter(asset => asset.wechatUrl),
    cover: assets.find(asset => asset.role === 'cover'),
    assets,
    failed: [],
  };
}

export async function getArticleWorkspace(directoryId: string): Promise<ChatGPTWorkspaceResult> {
  assertValidDirectoryId(directoryId);
  const workspace = await readWorkspaceRecord(directoryId);
  if (!workspace) {
    throw new Error(`目录不存在: ${directoryId}`);
  }

  const workspaceDir = getWorkspaceDir(directoryId);
  const assets = await readWorkspaceAssets(directoryId);
  const articleHtmlPath = path.join(workspaceDir, 'article.wechat.html');
  const articleHtml = await fileExists(articleHtmlPath)
    ? await fs.readFile(articleHtmlPath, 'utf8')
    : undefined;
  const cover = assets.find(asset => asset.role === 'cover');

  return {
    ok: true,
    directoryId,
    topicSlug: workspace.topicSlug,
    revision: workspace.revision,
    baseDir: getChatGPTAssetsBaseDir(),
    workspaceDir,
    articleHtml,
    inlineImages: assets.filter(asset => asset.wechatUrl),
    cover,
    assets,
    failed: [],
  };
}
