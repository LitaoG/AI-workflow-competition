import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { codemodFacadeScript } from '../../../src/dwf/ast-codemod.js';
import { compileFacadeScript, analyzeFacadeScript } from '../../../src/dwf/compile.js';

describe('AST Codemod pre-pass for facade scripts (Issue #300)', () => {
  test('clean pass-through of compliant scripts (modified: false)', () => {
    const compliant = `// Compliant dynamic workflow script
phase("Init");
const p = agent("planner");
const list = await files.glob("src/**/*.ts");
const result = await p.ask<Plan>("create a plan");
report(result);
return { list, result };

interface Plan {
  steps: string[];
}
`;
    const codemod = codemodFacadeScript(compliant);
    assert.equal(codemod.modified, false);
    assert.equal(codemod.code, compliant);

    const compiled = compileFacadeScript(compliant);
    assert.equal(compiled.modified, false);
    assert.equal(compiled.code, compliant);
    assert.equal(compiled.analysis.ok, true, JSON.stringify(compiled.analysis.diagnostics));
    assert.ok(compiled.lowered);
    assert.ok(compiled.lowered.js.includes('__host.ask'));
    assert.ok(compiled.lowered.js.includes('__host.worldRead'));
  });

  test('namespace destructuring desugaring (files, world, git, artifact, budget, sessions, fanout)', () => {
    const script = `// File operations
const { glob, read } = files;
const list = await glob("*.ts");
const content = await read("foo.txt");
return { list, content };
`;
    // Direct analysis would reject with 9001
    const direct = analyzeFacadeScript(script);
    assert.equal(direct.ok, false);
    assert.ok(direct.diagnostics.some((d) => d.code === 9001));

    // Codemod desugars it
    const res = codemodFacadeScript(script);
    assert.equal(res.modified, true);
    assert.ok(!res.code.includes('const { glob, read } = files'));
    assert.ok(res.code.includes('await files.glob("*.ts")'));
    assert.ok(res.code.includes('await files.read("foo.txt")'));

    // Compile through compileFacadeScript
    const compiled = compileFacadeScript(script);
    assert.equal(compiled.modified, true);
    assert.equal(compiled.analysis.ok, true, JSON.stringify(compiled.analysis.diagnostics));
    assert.ok(compiled.lowered);
    assert.ok(compiled.lowered.js.includes('__host.worldRead'));
  });

  test('other facade namespaces destructuring (world, git, budget)', () => {
    const script = `const { run } = world;
const { changedFiles } = git;
const { spent } = budget;
const changes = await changedFiles();
const output = await run("node", ["--version"]);
const s = spent();
return { changes, output, s };
`;
    const res = codemodFacadeScript(script);
    assert.equal(res.modified, true);
    assert.ok(!res.code.includes('const { run } = world'));
    assert.ok(!res.code.includes('const { changedFiles } = git'));
    assert.ok(!res.code.includes('const { spent } = budget'));
    assert.ok(res.code.includes('await git.changedFiles()'));
    assert.ok(res.code.includes('await world.run("node", ["--version"])'));
    assert.ok(res.code.includes('budget.spent()'));

    const compiled = compileFacadeScript(script);
    assert.equal(compiled.modified, true);
    assert.equal(compiled.analysis.ok, true, JSON.stringify(compiled.analysis.diagnostics));
  });

  test('aliased namespace property destructuring', () => {
    const script = `const { glob: findFiles, read: readFile } = files;
const list = await findFiles("*.json");
const data = await readFile("package.json");
return { list, data };
`;
    const res = codemodFacadeScript(script);
    assert.equal(res.modified, true);
    assert.ok(!res.code.includes('const { glob: findFiles'));
    assert.ok(res.code.includes('await files.glob("*.json")'));
    assert.ok(res.code.includes('await files.read("package.json")'));

    const compiled = compileFacadeScript(script);
    assert.equal(compiled.modified, true);
    assert.equal(compiled.analysis.ok, true, JSON.stringify(compiled.analysis.diagnostics));
  });

  test('agent call destructuring desugaring (direct inline call)', () => {
    const script = `const { ask } = agent("reviewer", { tier: "deep" });
const verdict = await ask<ReviewResult>("check the diff");
return verdict;

interface ReviewResult {
  approved: boolean;
}
`;
    const res = codemodFacadeScript(script);
    assert.equal(res.modified, true);
    assert.ok(!res.code.includes('const { ask } = agent'));
    assert.ok(res.code.includes('agent("reviewer", { tier: "deep" }).ask<ReviewResult>("check the diff")'));

    const compiled = compileFacadeScript(script);
    assert.equal(compiled.modified, true);
    assert.equal(compiled.analysis.ok, true, JSON.stringify(compiled.analysis.diagnostics));
    assert.ok(compiled.lowered);
    assert.ok(compiled.lowered.js.includes('__host.createActor'));
    assert.ok(compiled.lowered.js.includes('__host.ask'));
  });

  test('agent variable destructuring desugaring (pre-bound agent var)', () => {
    const script = `const planner = agent("planner");
const { ask: planAsk } = planner;
const plan = await planAsk("formulate steps");
return plan;
`;
    const res = codemodFacadeScript(script);
    assert.equal(res.modified, true);
    assert.ok(!res.code.includes('const { ask: planAsk } = planner'));
    assert.ok(res.code.includes('const planner = agent("planner")'));
    assert.ok(res.code.includes('await planner.ask("formulate steps")'));

    const compiled = compileFacadeScript(script);
    assert.equal(compiled.modified, true);
    assert.equal(compiled.analysis.ok, true, JSON.stringify(compiled.analysis.diagnostics));
  });

  test('multiple calls from single destructured agent or namespace', () => {
    const script = `const { ask } = agent("worker");
const a = await ask("task 1");
const b = await ask("task 2");
return { a, b };
`;
    const res = codemodFacadeScript(script);
    assert.equal(res.modified, true);
    assert.ok(res.code.includes('await agent("worker").ask("task 1")'));
    assert.ok(res.code.includes('await agent("worker").ask("task 2")'));

    const compiled = compileFacadeScript(script);
    assert.equal(compiled.modified, true);
    assert.equal(compiled.analysis.ok, true, JSON.stringify(compiled.analysis.diagnostics));
  });

  test('mixed variable declarations (removes only destructuring, keeps others)', () => {
    const script = `const { glob } = files, answer = 42, label = "test";
const filesList = await glob("*.ts");
return { filesList, answer, label };
`;
    const res = codemodFacadeScript(script);
    assert.equal(res.modified, true);
    assert.ok(!res.code.includes('{ glob } = files'));
    assert.ok(res.code.includes('answer = 42'));
    assert.ok(res.code.includes('label = "test"'));
    assert.ok(res.code.includes('await files.glob("*.ts")'));

    const compiled = compileFacadeScript(script);
    assert.equal(compiled.modified, true);
    assert.equal(compiled.analysis.ok, true, JSON.stringify(compiled.analysis.diagnostics));
  });

  test('comment preservation across desugaring', () => {
    const script = `// Section 1: Setup
const { glob } = files;
// Section 2: Execution
const list = await glob("*.ts");
/* Tail comment */
return list;
`;
    const res = codemodFacadeScript(script);
    assert.equal(res.modified, true);
    assert.ok(res.code.includes('Section 1: Setup'));
    assert.ok(res.code.includes('Section 2: Execution'));
    assert.ok(res.code.includes('Tail comment'));
    assert.ok(res.code.includes('files.glob("*.ts")'));
  });

  test('shadowing and scope safety (does not rewrite shadowed locals or object props)', () => {
    const script = `const { glob } = files;
const list = await glob("*.ts");

function localShadow(glob: string) {
  return glob;
}

const obj = { glob: "propertyValue" };
return { list, local: localShadow("hello"), prop: obj.glob };
`;
    const res = codemodFacadeScript(script);
    assert.equal(res.modified, true);
    assert.ok(res.code.includes('await files.glob("*.ts")'));
    assert.ok(res.code.includes('function localShadow(glob: string)'));
    assert.ok(res.code.includes('return glob;'));
    assert.ok(res.code.includes('{ glob: "propertyValue" }'));
    assert.ok(res.code.includes('obj.glob'));

    const compiled = compileFacadeScript(script);
    assert.equal(compiled.modified, true);
    assert.equal(compiled.analysis.ok, true, JSON.stringify(compiled.analysis.diagnostics));
  });

  test('end-to-end compilation handles non-destructuring compile errors faithfully', () => {
    const badScript = `const { glob } = files;
await glob("*.ts");
const evil = eval("1 + 1");
return evil;
`;
    const compiled = compileFacadeScript(badScript);
    assert.equal(compiled.modified, true);
    assert.equal(compiled.analysis.ok, false);
    assert.ok(compiled.analysis.diagnostics.some((d) => d.code === 9002 && d.message.includes('"eval" is banned')));
    assert.equal(compiled.lowered, undefined);
  });
});
