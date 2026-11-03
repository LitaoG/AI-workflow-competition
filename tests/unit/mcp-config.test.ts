import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// compiled at dist/tests/unit/mcp-config.test.js → three levels up is the repo root
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('Claude Code project MCP config starts the facade server', () => {
  const config = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.mcp.json'), 'utf8')) as {
    mcpServers?: Record<string, { type?: string; command?: string; args?: string[] }>;
  };
  const server = config.mcpServers?.['ai-workflow'];
  assert.ok(server, 'ai-workflow server entry exists');
  assert.equal(server.type, 'stdio');
  assert.equal(server.command, 'node');
  assert.deepEqual(server.args, ['${CLAUDE_PROJECT_DIR:-.}/bin/workflow.js', 'mcp', 'serve']);
});

test('Claude Code skill wrapper points at the canonical skill', () => {
  // Git may check this file out with CRLF on Windows; normalize before matching.
  const skill = fs
    .readFileSync(path.join(REPO_ROOT, '.claude', 'skills', 'ai-workflow', 'SKILL.md'), 'utf8')
    .replace(/\r\n/g, '\n');
  assert.match(skill, /^---\nname: ai-workflow/m);
  assert.match(skill, /skills\/ai-workflow\/SKILL\.md/);
});