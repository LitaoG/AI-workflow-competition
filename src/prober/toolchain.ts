import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { ToolchainProbe } from '../types.js';

const execAsync = promisify(exec);

async function checkVersion(cmd: string, timeoutMs = 2000): Promise<string> {
  try {
    const { stdout } = await execAsync(cmd, { timeout: timeoutMs, windowsHide: true });
    return stdout.trim().split('\n')[0] ?? 'installed';
  } catch {
    return 'not_installed';
  }
}

export async function probeToolchain(): Promise<ToolchainProbe> {
  const isWin = process.platform === 'win32';
  const npmCmd = isWin ? 'npm.cmd --version' : 'npm --version';

  const [nodeV, npmV, gitV, pythonV, tscV] = await Promise.all([
    checkVersion('node --version'),
    checkVersion(npmCmd),
    checkVersion('git --version'),
    checkVersion('python --version').then((v) => (v === 'not_installed' ? checkVersion('python3 --version') : v)),
    checkVersion(isWin ? 'npx.cmd tsc --version' : 'npx tsc --version').catch(() => 'not_installed'),
  ]);

  return {
    node: nodeV !== 'not_installed' ? nodeV : process.version,
    // Missing tools stay undefined (same honest path as python/tsc): the prober
    // reports measured facts only, never a fabricated version (Issue #88).
    npm: npmV !== 'not_installed' ? npmV : undefined,
    git: gitV !== 'not_installed' ? gitV : undefined,
    python: pythonV !== 'not_installed' ? pythonV : undefined,
    tsc: tscV !== 'not_installed' ? tscV : undefined,
  };
}
