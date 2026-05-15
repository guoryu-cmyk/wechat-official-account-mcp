import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StorageManager } from './dist/src/storage/storage-manager.js';

const testDir = mkdtempSync(path.join(tmpdir(), 'wechat-mcp-storage-'));
const testDbPath = path.join(testDir, 'wechat-mcp.db');

process.env.DB_PATH = testDbPath;

try {
  const storageManager = new StorageManager();
  await storageManager.initialize();
  await storageManager.close();

  assert.equal(
    existsSync(testDbPath),
    true,
    'StorageManager should create the database at DB_PATH when it is configured',
  );

  console.log('Storage DB_PATH configuration verified');
} finally {
  delete process.env.DB_PATH;
  rmSync(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
