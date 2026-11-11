import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFacadeScript } from '../../../src/dwf/compile.js';
import { lowerFacadeScript } from '../../../src/dwf/lower.js';

// Issue #85: channel/future 纯 cell 原语 —— 编译层与 lowering 层（T1-T5）。
// 纯 cell 语义：零 FacadeSiteKind、零 site 注册、零 journal 簿记 —— 编译层只锁
// （a）d.ts 全表面形状（T1）、（b）遮蔽禁名 9004（T2）、（c）9001 siting（T3）、
// （d）站点游标零扰动（T4，回归护栏）、（e）lowering 改写 __channel()/__future()（T5）。

// T1 全表面（channel/future 的每个成员都摸一遍，形状钉死）：任一成员漏声明/改名即 TS2339 破此断言。
const FULL_SURFACE = `
const ch = channel<number>();
ch.send(1);
ch.send(2);
ch.close();
const first = await ch.receive();
let drained: number[] = [];
for await (const x of ch) {
  drained.push(x);
}
const f = future<string>();
f.resolve("ok");
const resolved = await f.promise;
const g = future();
g.reject(new Error("boom"));
let reason = "";
try {
  await g.promise;
} catch (e) {
  if (e instanceof Error) reason = e.message;
}
return { first, drained, resolved, reason };
`;

test('T1: full-surface channel/future script clean-compiles with zero sites and zero journal bookkeeping', () => {
  const r = analyzeFacadeScript(FULL_SURFACE);
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  assert.deepEqual(r.sites, []);
  assert.deepEqual(r.phases, []);
  assert.deepEqual(r.commands, []);
  assert.deepEqual(r.actors, []);
});

test('T2: shadowing channel/future/Channel/Future is a 9004 facade-misuse', () => {
  for (const name of ['channel', 'future', 'Channel', 'Future']) {
    const r = analyzeFacadeScript(`const ${name} = 3;\nreturn null;`);
    assert.equal(r.ok, false, name);
    const hit = r.diagnostics.find((d) => d.code === 9004);
    assert.ok(hit, `9004 for shadowing ${name}: ${JSON.stringify(r.diagnostics)}`);
    assert.equal(hit!.category, 'facade-misuse');
    assert.ok(hit!.message.includes(name), hit!.message);
  }
});

test('T3: taking a reference to channel/future is 9001 siting (direct calls stay legal)', () => {
  for (const snippet of ['const c = channel;', 'const f = future;', 'channel.bind(null);']) {
    const r = analyzeFacadeScript(`${snippet}\nreturn null;`);
    const hit = r.diagnostics.find((d) => d.code === 9001);
    assert.ok(hit, `9001 for "${snippet}": ${JSON.stringify(r.diagnostics)}`);
    assert.equal(hit!.category, 'facade-misuse');
    assert.ok(hit!.message.includes('may only be called directly'), hit!.message);
  }
});

test('T4: site cursor zero disturbance — cell calls produce no sites and never misalign the table', () => {
  const r = analyzeFacadeScript(`
phase("P");
const a = await agent("x").ask<string>("y");
log("l");
const ch = channel();
const f = future();
ch.send(1);
ch.close();
return a;
`);
  assert.deepEqual(
    r.sites.map((s) => `${s.siteId}:${s.kind}`),
    ['phase#1:phase', 'ask#2:ask', 'actor#3:actor', 'log#4:log'],
  );
  assert.ok(r.diagnostics.every((d) => d.code !== 9001 && d.code !== 9004), JSON.stringify(r.diagnostics));
});

test('T5: lowering rewrites channel()/future() into __channel()/__future() with zero site stamps', () => {
  const r = lowerFacadeScript('const ch = channel();\nch.send(1);\nch.close();\nconst f = future();\nf.resolve(1);\nreturn null;');
  assert.match(r.js, /__channel\(/);
  assert.match(r.js, /__future\(/);
  assert.doesNotMatch(r.js, /(^|[^_\w])channel\(/);
  assert.deepEqual(r.analysis.sites, []);
  assert.ok(!/#\d+/.test(r.js), 'no siteId stamps in lowered js');
});
