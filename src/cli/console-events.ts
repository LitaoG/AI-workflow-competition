/**
 * Single-source console rendering for dwf journal events (Issue #106): the
 * run-script / fill / answer / workflows commands used to carry four diverging
 * inline renderers — same event, different wording. Every command feeds its
 * `onEvent` here; `--progress` keeps its own structured printer
 * (src/dwf/progress.ts) and is unaffected.
 */
import { resolveLang, t, type SupportedLang } from './i18n/index.js';

/** The runner's onEvent shape (src/dwf/runner.ts): loose type + record data. */
type DwfStreamEvent = { type: string; data: Record<string, unknown> };

export function printDwfEvent(e: DwfStreamEvent, lang?: SupportedLang): void {
  switch (e.type) {
    case 'dwf_phase':
      console.log(`\n--- ${e.data.phase} ---`);
      break;
    case 'dwf_actor_created':
      console.log(`  agent: ${e.data.name}`);
      break;
    case 'dwf_log':
      console.log(`  log: ${e.data.message}`);
      break;
    case 'dwf_report':
      console.log(`  report: ${JSON.stringify(e.data.item)}`);
      break;
    case 'dwf_ask_start':
      console.log(`  ask → ${e.data.actor} (${e.data.siteId})`);
      break;
    case 'dwf_ask_complete':
      console.log(`  ✔ ask done (${e.data.siteId})`);
      break;
    case 'dwf_replay_hit':
      console.log(`  ⚡ replayed from journal: ${e.data.siteId}#${e.data.ordinal} (0 provider calls)`);
      break;
    case 'dwf_amend_hit':
      console.log(`  ♻ amended run reused: ${e.data.siteId}#${e.data.ordinal} (0 provider calls)`);
      break;
    case 'dwf_amend_diverged':
      // The event fires before the live ordinal is allocated and is
      // per-actor once — the siteId already carries the node number.
      console.log(`  ⑂ amended run diverged: ${e.data.siteId} (executing live)`);
      break;
    case 'dwf_world_run':
      console.log(`  $ ${e.data.cmd} ${(e.data.args as string[] | undefined)?.join(' ') ?? ''}`);
      break;
    case 'dwf_artifact':
      console.log(`  📄 artifact ${e.data.id} v${e.data.version} (${e.data.bytes} bytes)`);
      break;
    case 'dwf_hole_open':
      console.log(`  ⏸ hole open: ${e.data.name} (${e.data.siteId})`);
      break;
    case 'dwf_escalation_open':
      console.log(`  ❓ escalation open: ${e.data.questionId}`);
      break;
    case 'dwf_call_error':
      console.error(`  ✖ ${e.data.siteId ?? e.data.op}: ${e.data.error}`);
      break;
    case 'dwf_resume_takeover':
      // Stale-run takeover (GOAL.md §1.5): the recorded host pid is dead
      // (or the row predates pid recording) — this host is continuing.
      if (e.data.deadPid === undefined) {
        console.log(t('MSG_DWF_RESUME_TAKEOVER_NO_PID', undefined, resolveLang(lang)));
      } else {
        console.log(t('MSG_DWF_RESUME_TAKEOVER', { pid: Number(e.data.deadPid) }, resolveLang(lang)));
      }
      break;
    default:
      break;
  }
}
