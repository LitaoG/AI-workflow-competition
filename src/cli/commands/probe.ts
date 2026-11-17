import { probe } from '../../prober/index.js';
import { t, resolveLang } from '../i18n/index.js';

export interface ProbeCommandOptions {
  output?: 'json' | 'text';
  json?: boolean;
  strict?: boolean;
  lang?: string;
}

export async function executeProbe(targetDir?: string, options?: ProbeCommandOptions): Promise<number> {
  const lang = resolveLang(options?.lang);
  const cwd = targetDir ?? process.cwd();

  try {
    const result = await probe({ cwd });

    if (options?.output === 'json' || options?.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`========================================================================`);
      console.log(lang === 'zh' ? ` 环境探测结果 (AI-Workflow Deterministic Environment Prober)` : ` AI-Workflow Deterministic Environment Prober`);
      console.log(` Timestamp: ${result.timestamp}`);
      console.log(`========================================================================`);

      console.log(`\n[${t('PROBE_SYSTEM_HEADER', {}, lang)}]`);
      console.log(`  OS Platform:   ${result.system.platform} (${result.system.arch})`);
      console.log(`  CPU Cores:     ${result.system.cpus} x ${result.system.cpuModel}`);
      console.log(`  Memory (MB):   Total: ${result.system.totalMemMb}MB | Free: ${result.system.freeMemMb}MB`);
      console.log(`  Node Version:  ${result.system.nodeVersion}`);

      console.log(`\n[${t('PROBE_GIT_HEADER', {}, lang)}]`);
      console.log(`  Is Git Repo:   ${result.git.isGitRepo}`);
      console.log(`  Current Branch: ${result.git.branch}`);
      console.log(`  Commit SHA:    ${result.git.commit}`);
      console.log(`  Is Dirty:      ${result.git.isDirty ? `YES (${result.git.dirtyFilesCount} files modified/untracked)` : 'Clean'}`);
      if (result.git.remoteUrl) {
        console.log(`  Remote URL:    ${result.git.remoteUrl}`);
      }

      console.log(`\n[${t('PROBE_TOOLCHAIN_HEADER', {}, lang)}]`);
      console.log(`  Node.js:       ${result.toolchain.node}`);
      console.log(`  npm:           ${result.toolchain.npm ?? 'not_installed'}`);
      console.log(`  git:           ${result.toolchain.git ?? 'not_installed'}`);
      if (result.toolchain.python) console.log(`  python:        ${result.toolchain.python}`);
      if (result.toolchain.tsc) console.log(`  typescript:    ${result.toolchain.tsc}`);

      const redactedCount = Object.values(result.env).filter((v) => v === '***REDACTED***').length;
      console.log(`\n[${t('PROBE_SANITIZED_HEADER', { count: redactedCount }, lang)}]`);
      console.log(`  Total Env Keys: ${Object.keys(result.env).length}`);
      console.log(`  Redacted Keys:  ${redactedCount}`);
    }

    if (options?.strict && result.git.isDirty) {
      console.error(`\nError: Strict probe failed: Git repository is dirty.`);
      return 1;
    }

    return 0;
  } catch (err: any) {
    console.error(`Prober Error: ${err.message}`);
    return 1;
  }
}
