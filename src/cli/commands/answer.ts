/**
 * `/workflow answer <runId> <questionId> <text...>` — answer an escalation a parked
 * run is waiting on. The answer is journalled on the run; a resume replays the prefix
 * at zero cost and the escalate() call resolves to the answer text.
 */
import { createSQLiteStore } from '../../state/store.js';
import type { SQLiteStateStore } from '../../state/sqlite-store.js';
import type { DwfJournalStore, WorkflowEventType } from '../../types.js';
import { runFacadeScript } from '../../dwf/runner.js';

export async function executeAnswer(
  runId: string,
  questionId: string,
  textParts: string[],
  options: { dbPath?: string; lang?: string },
): Promise<number> {
  const answer = textParts.join(' ').trim();
  if (!answer) {
    console.error('Error: an answer text is required — workflow answer <runId> <questionId> <text...>');
    return 1;
  }

  const store = createSQLiteStore(options.dbPath ?? '.workflow/dwf.sqlite') as SQLiteStateStore & DwfJournalStore;
  try {
    const run = await store.getDwfRun(runId);
    if (!run) {
      console.error(`Error: run "${runId}" not found`);
      return 1;
    }
    if (!run.scriptPath) {
      console.error(`Error: run "${runId}" has no script to resume`);
      return 1;
    }

    // Locate the escalation site by its question id on the run's event stream.
    const events = await store.getEvents(runId);
    const open = [...events].reverse().find((e) => e.type === ('dwf_escalation_open' as WorkflowEventType) && (e.data as { questionId?: string })?.questionId === questionId);
    if (!open) {
      console.error(`Error: no open escalation with id "${questionId}" on run "${runId}"`);
      return 1;
    }
    const siteId = String((open.data as { siteId: string }).siteId);
    const question = String((open.data as { question: string }).question ?? '');

    // Journal the answer — the replay key must match what the engine computed at open.
    const openHash = (open.data as { inputHash?: string }).inputHash;
    if (!openHash) {
      console.error(`Error: the open escalation event for "${questionId}" predates the pool-matching format — start a fresh run`);
      return 1;
    }
    const priorRows = (await store.getDwfNodes(runId)).filter((n) => n.siteId === siteId && n.kind === 'escalation');
    const inputHash = openHash;
    await store.saveDwfNode({
      runId,
      siteId,
      ordinal: priorRows.length + 1,
      kind: 'escalation',
      inputHash,
      status: 'completed',
      resultJson: JSON.stringify(answer),
      completedAt: new Date().toISOString(),
    });
    console.log(`✔ answer journalled for ${questionId} (site ${siteId}) — resuming the run`);

    // Resume: same script (unchanged), prefix replays at zero cost, escalate() resolves.
    const result = await runFacadeScript({
      scriptPath: run.scriptPath,
      resumeRunId: runId,
      dbPath: options.dbPath,
      onEvent: (e) => {
        if (e.type === 'dwf_replay_hit') console.log(`  ⚡ replayed: ${e.data.siteId}#${e.data.ordinal}`);
        if (e.type === 'dwf_phase') console.log(`\n--- ${e.data.phase} ---`);
        if (e.type === 'dwf_ask_complete') console.log(`  ✔ ask done (${e.data.siteId})`);
        if (e.type === 'dwf_escalation_open') console.log(`  ❓ escalation open: ${e.data.questionId}`);
      },
    });

    if (result.status === 'completed') {
      console.log(`\n✔ run ${runId} completed with the answer in hand`);
      console.log(`  result: ${JSON.stringify(result.value)}`);
      return 0;
    }
    if (result.status === 'parked') {
      console.log(`\n⏸ run ${runId} parked again at: ${result.parkedAt?.name} (${result.parkedAt?.kind})`);
      return 0;
    }
    console.error(`\n✖ resumed run failed: ${result.error}`);
    return 1;
  } finally {
    store.close();
  }
}
