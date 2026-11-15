import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorldBoundary } from '../../src/dwf/host-boundary-dispatcher.js';
import { isSchemaValidationError, type DomainError } from '../../src/domain/errors.js';

describe('WorldBoundary - workspace path resolution and symlink containment', () => {
  test('valid workspace file reads succeed', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-test-valid-'));
    try {
      const filePath = path.join(tmpDir, 'hello.txt');
      fs.writeFileSync(filePath, 'hello world content', 'utf8');

      const boundary = new WorldBoundary(tmpDir);
      const content = await boundary.read('files.read', ['hello.txt'], 'test-site-1');
      assert.equal(content, 'hello world content');

      const resolved = boundary.resolveInsideWorkspace('hello.txt', 'files.read path');
      assert.equal(resolved.toLowerCase(), fs.realpathSync(filePath).toLowerCase());
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  test('lexical workspace escape throws SchemaValidationError', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-test-escape-'));
    try {
      const boundary = new WorldBoundary(tmpDir);
      assert.throws(
        () => boundary.resolveInsideWorkspace('../escaped.txt', 'files.read path'),
        (err: unknown) => {
          assert.ok(isSchemaValidationError(err as DomainError));
          assert.match((err as Error).message, /escapes the workspace/);
          return true;
        },
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  test('symlink or junction escaping workspace throws SchemaValidationError', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-test-symlink-'));
    try {
      const outsideDir = path.join(baseDir, 'outside');
      fs.mkdirSync(outsideDir);
      const outsideFile = path.join(outsideDir, 'secret.txt');
      fs.writeFileSync(outsideFile, 'top-secret', 'utf8');

      const wsDir = path.join(baseDir, 'workspace');
      fs.mkdirSync(wsDir);

      const linkPath = path.join(wsDir, 'linked_outside');
      if (process.platform === 'win32') {
        fs.symlinkSync(outsideDir, linkPath, 'junction');
      } else {
        fs.symlinkSync(outsideDir, linkPath, 'dir');
      }

      const boundary = new WorldBoundary(wsDir);

      // Verify resolveInsideWorkspace throws SchemaValidationError
      assert.throws(
        () => boundary.resolveInsideWorkspace('linked_outside/secret.txt', 'files.read path'),
        (err: unknown) => {
          assert.ok(isSchemaValidationError(err as DomainError));
          assert.match((err as Error).message, /symlink escapes the workspace/);
          return true;
        },
      );

      // Verify read('files.read') also rejects with SchemaValidationError
      await assert.rejects(
        async () => {
          await boundary.read('files.read', ['linked_outside/secret.txt'], 'test-site-2');
        },
        (err: unknown) => {
          assert.ok(isSchemaValidationError(err as DomainError));
          assert.match((err as Error).message, /symlink escapes the workspace/);
          return true;
        },
      );
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  test('symlink pointing inside the workspace succeeds', async () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-test-insidelink-'));
    try {
      const targetDir = path.join(wsDir, 'target');
      fs.mkdirSync(targetDir);
      fs.writeFileSync(path.join(targetDir, 'inner.txt'), 'inner content', 'utf8');

      const linkPath = path.join(wsDir, 'link_inside');
      if (process.platform === 'win32') {
        fs.symlinkSync(targetDir, linkPath, 'junction');
      } else {
        fs.symlinkSync(targetDir, linkPath, 'dir');
      }

      const boundary = new WorldBoundary(wsDir);
      const content = await boundary.read('files.read', ['link_inside/inner.txt'], 'test-site-3');
      assert.equal(content, 'inner content');
    } finally {
      fs.rmSync(wsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});
