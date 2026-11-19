/**
 * Best-effort default-browser launcher (Mission D: `--ui` / `demo` /
 * `serve` auto-raise the Studio). Never throws: a headless box just skips it.
 */
import { spawn } from 'node:child_process';

export function openInBrowser(url: string): boolean {
  // Issue #146 test affordance: automated harnesses (the integration suite
  // drives `run --ui` end-to-end) set AI_WORKFLOW_NO_OPEN=1; default behavior
  // is unchanged.
  if (process.env.AI_WORKFLOW_NO_OPEN === '1') return false;
  try {
    if (process.platform === 'win32') {
      // `start` treats its first quoted argument as the window title — pass an
      // empty title so URLs with `&` survive.
      const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
      child.unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    return true;
  } catch {
    return false;
  }
}
