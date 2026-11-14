/**
 * `workflow demo` — the one-second WOW moment (Mission D 支柱四).
 *
 * Runs the flagship Incident-Triage facade fully offline on the deterministic
 * mock provider into a dedicated demo journal, renders the AI-Workflow Studio
 * as a standalone page and raises the default browser. Deterministic: same
 * script + args + mock provider ⇒ byte-identical result every run.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { runFacadeScript } from '../../dwf/runner.js';
import { createSQLiteStore } from '../../state/store.js';
import { SQLiteStateStore } from '../../state/sqlite-store.js';
import { DwfJournalStore } from '../../types.js';
import { buildStudioSnapshot } from '../../dwf/live.js';
import { renderStudioHtml } from '../../visualizer/studio-renderer.js';
import { resolveLang, type SupportedLang } from '../i18n/index.js';

/** Issue #128 F1: the demo's own console strings (en/zh) — resolveLang reads
 *  --lang and AI_WORKFLOW_LANG, which the demo previously never consumed. */
const DEMO_I18N: Record<SupportedLang, Record<string, string>> = {
  en: {
    done: '✔ demo run {id} completed in {s}s (deterministic mock — 0 network calls)',
    result: '  result: ',
    studio: '  studio: ',
    opened: '  opened: ',
    manual: '  open it manually: ',
    next: '\nNext steps:',
    hint1: '  workflow new my-flow --template code-review   # scaffold your own',
    hint2: '  workflow run my-flow.facade.ts --set key=value # run it',
  },
  zh: {
    done: '✔ 演示运行 {id} 已完成，耗时 {s}s（确定性 mock——零网络调用）',
    result: '  结果: ',
    studio: '  看板: ',
    opened: '  已打开: ',
    manual: '  请手动打开: ',
    next: '\n后续步骤:',
    hint1: '  workflow new my-flow --template code-review   # 脚手架你自己的工作流',
    hint2: '  workflow run my-flow.facade.ts --set key=value # 运行它',
  },
};
import { openInBrowser } from './open-browser.js';

export interface DemoCommandOptions {
  /** Skip raising the default browser. */
  noOpen?: boolean;
  open?: boolean;
  lang?: string;
}

/** Walk up from this module to the package root (works from dist/ and src/). */
function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

export async function executeDemo(options?: DemoCommandOptions): Promise<number> {
  const lang = resolveLang(options?.lang);
  const T = DEMO_I18N[lang];
  const root = packageRoot();
  const scriptPath = path.join(root, 'apps', 'incident-triage-remediation', 'facade.workflow.ts');
  if (!fs.existsSync(scriptPath)) {
    console.error(`Error: demo script not found at ${scriptPath}`);
    return 1;
  }
  const dbPath = path.join(process.cwd(), '.workflow', 'demo-dwf.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const started = Date.now();
  let result;
  try {
    result = await runFacadeScript({
      scriptPath,
      args: { scenario: 'p1_db_pool_exhaustion' },
      dbPath,
      // First-party curated demo: its world.run commands (all `node`) are
      // authorized by the product, not by the script's own list (Issue #127).
      approvedCommands: ['node'],
    });
  } catch (err) {
    console.error(`Demo failed: ${(err as Error).message}`);
    return 1;
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(2);

  if (result.status !== 'completed') {
    console.error(`✖ demo run ${result.runId} ended as ${result.status}: ${result.error}`);
    return 1;
  }

  // Render the Studio for the demo run (static — survives process exit).
  const store = createSQLiteStore(dbPath) as SQLiteStateStore & DwfJournalStore;
  let html: string;
  try {
    const snap = await buildStudioSnapshot(store, result.runId, { live: false });
    html = renderStudioHtml(snap, { live: false, lang });
  } finally {
    store.close();
  }
  const viewsDir = path.join(process.cwd(), '.workflow', 'views');
  fs.mkdirSync(viewsDir, { recursive: true });
  const htmlPath = path.join(viewsDir, 'demo.html');
  fs.writeFileSync(htmlPath, html);

  console.log(T.done.replace('{id}', result.runId).replace('{s}', seconds));
  console.log(`${T.result}${JSON.stringify(result.value)}`);
  console.log(`${T.studio}${htmlPath}`);

  if (!options?.noOpen && options?.open !== false) {
    const url = pathToFileURL(htmlPath).href;
    if (openInBrowser(url)) console.log(`  opened: ${url}`);
    else console.log(`  open it manually: ${url}`);
  }
  console.log('\nNext steps:');
  console.log('  workflow new my-flow --template code-review   # scaffold your own');
  console.log('  workflow run my-flow.facade.ts --set key=value # run it');
  return 0;
}
