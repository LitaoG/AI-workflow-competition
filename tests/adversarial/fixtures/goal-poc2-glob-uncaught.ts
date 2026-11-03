/**
 * goal-poc2 (uncaught form): a workspace holding 3000 files vs `files.glob('*.txt')` —
 * past the 2000-file cap. Run it with the CWD set to a directory containing 3000
 * `*.txt` files (the regression test goal-poc2-glob-bomb.test.ts builds that bomb in a
 * temp dir and runs this fixture byte-identical from there).
 *
 * Expected defense (src/dwf/engine.ts:595-599 + src/dwf/glob.ts:54): the walk collects
 * cap+1 = 2001 matches and the call REJECTS with "files.glob matched more than 2000
 * files — narrow the pattern"; uncaught, the run fails structurally.
 */
phase('bomb');
const all = await files.glob('*.txt');
return { matched: all.length };
