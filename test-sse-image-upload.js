import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getSseImageUploadTempDir,
  saveUploadedImageToTemp,
} from './dist/src/mcp-server/transport/image-upload.js';
import {
  appendChunkedImageUpload,
  finishChunkedImageUpload,
  IMAGE_UPLOAD_CHUNK_BASE64_CHARS,
  IMAGE_UPLOAD_MAX_CHUNK_BASE64_CHARS,
  startChunkedImageUpload,
} from './dist/src/utils/chunked-image-upload.js';
import {
  buildImageUploadTicketUrl,
  consumeImageUploadTicket,
  createImageUploadTicket,
  getImageUploadTicketCount,
  getMcpUploadCurlResolve,
  IMAGE_UPLOAD_TICKET_QUERY_KEY,
} from './dist/src/utils/image-upload-ticket.js';

const pngFixture = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082',
  'hex',
);

assert.equal(
  getSseImageUploadTempDir(),
  path.join(os.homedir(), 'wechat-official-account-mcp', 'temp'),
  'default upload directory should be ~/wechat-official-account-mcp/temp',
);

const uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-mcp-upload-'));
process.env.WECHAT_MCP_IMAGE_UPLOAD_DIR = uploadRoot;

try {
  assert.equal(
    IMAGE_UPLOAD_CHUNK_BASE64_CHARS,
    256 * 1024,
    'default staged upload chunk should avoid excessive append calls',
  );
  assert.equal(
    IMAGE_UPLOAD_MAX_CHUNK_BASE64_CHARS,
    512 * 1024,
    'single staged upload chunk should keep a safe upper bound',
  );

  const saved = await saveUploadedImageToTemp({
    buffer: pngFixture,
    originalName: '../../unsafe name.PNG',
  });

  assert.equal(saved.detectedFormat, 'png');
  assert.equal(saved.contentType, 'image/png');
  assert.equal(saved.size, pngFixture.length);
  assert.equal(path.dirname(saved.filePath), uploadRoot);
  assert.equal(fs.existsSync(saved.filePath), true, 'uploaded image should be written to disk');
  assert.match(saved.fileName, /^[a-z0-9._-]+\.png$/);

  await assert.rejects(
    () => saveUploadedImageToTemp({
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      originalName: 'broken.jpg',
    }),
    /JPEG 图片缺少 EOI 结束标记/,
    'truncated JPEG should be rejected before it is saved',
  );

  const chunkSession = await startChunkedImageUpload({
    fileName: 'chunked.png',
    totalChunks: 2,
    totalSize: pngFixture.length,
  });
  const base64Image = pngFixture.toString('base64');
  const splitAt = 40;

  await appendChunkedImageUpload({
    uploadId: chunkSession.uploadId,
    chunkIndex: 0,
    chunkData: base64Image.slice(0, splitAt),
  });
  await appendChunkedImageUpload({
    uploadId: chunkSession.uploadId,
    chunkIndex: 1,
    chunkData: base64Image.slice(splitAt),
  });

  const chunkedSaved = await finishChunkedImageUpload(chunkSession.uploadId);
  assert.equal(chunkedSaved.detectedFormat, 'png');
  assert.equal(chunkedSaved.size, pngFixture.length);
  assert.equal(fs.existsSync(chunkedSaved.filePath), true, 'chunked upload should produce a temp image file');
  fs.rmSync(chunkedSaved.filePath, { force: true });
} finally {
  delete process.env.WECHAT_MCP_IMAGE_UPLOAD_DIR;
  fs.rmSync(uploadRoot, { recursive: true, force: true });
}

process.env.MCP_PUBLIC_BASE_URL = 'https://example.com/mcp/';
const ticketCreatedAt = Date.now();
const ticket = createImageUploadTicket({ ttlSeconds: 60, now: ticketCreatedAt });
const uploadUrl = buildImageUploadTicketUrl(ticket.token);

assert.equal(
  uploadUrl,
  `https://example.com/mcp/upload-image?${IMAGE_UPLOAD_TICKET_QUERY_KEY}=${ticket.token}`,
  'prepare upload URL should include the configured public base URL and one-time token',
);

assert.equal(getImageUploadTicketCount(), 1, 'new ticket should be stored until it is consumed');
assert.equal(consumeImageUploadTicket(ticket.token, ticketCreatedAt + 1000).ok, true, 'fresh ticket should be accepted once');
assert.equal(consumeImageUploadTicket(ticket.token, ticketCreatedAt + 1000).ok, false, 'one-time ticket should be rejected after use');

const expiredTicket = createImageUploadTicket({ ttlSeconds: 60, now: 1000 });
const expiredConsumeResult = consumeImageUploadTicket(expiredTicket.token, 62000);
assert.equal(expiredConsumeResult.ok, false, 'expired ticket should be rejected');

delete process.env.MCP_PUBLIC_BASE_URL;

assert.equal(getMcpUploadCurlResolve(), undefined, 'curl resolve hint should be optional');
process.env.MCP_UPLOAD_CURL_RESOLVE = 'guoairong.site:443:110.42.214.78';
assert.equal(
  getMcpUploadCurlResolve(),
  'guoairong.site:443:110.42.214.78',
  'curl resolve hint should be read from environment',
);
delete process.env.MCP_UPLOAD_CURL_RESOLVE;

console.log('SSE image upload helpers verified');
