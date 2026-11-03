import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Creates an isolated temporary directory for test execution.
 */
export function createTempDir(prefix = 'ai-workflow-test-'): string {
  const tmpBase = os.tmpdir();
  const randomSuffix = Math.random().toString(36).substring(2, 10);
  const dirPath = path.join(tmpBase, `${prefix}${Date.now()}-${randomSuffix}`);
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

/**
 * Safely removes a temporary directory.
 */
export function cleanupTempDir(dirPath: string): void {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  } catch (err) {
    // Graceful cleanup error handling on Windows
    console.warn(`[WARN] Failed to clean up temp dir ${dirPath}:`, (err as Error).message);
  }
}

/**
 * Writes a file into a directory, ensuring parent directories exist.
 */
export function writeTempFile(baseDir: string, relativePath: string, content: string): string {
  const fullPath = path.join(baseDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
  return fullPath;
}

/**
 * Reads a file from a directory.
 */
export function readTempFile(baseDir: string, relativePath: string): string {
  const fullPath = path.join(baseDir, relativePath);
  return fs.readFileSync(fullPath, 'utf-8');
}
