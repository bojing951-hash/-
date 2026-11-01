/** Same assertions and inputs against frozen B04 or B05; no production calls. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const moduleUrl = process.env.B05_EVIDENCE_MODULE
  ? pathToFileURL(process.env.B05_EVIDENCE_MODULE).href
  : new URL('../scripts/b03-docker-evidence.mjs', import.meta.url).href;
const { evaluateDockerRaceEvidence: check, parseDockerEventLine: parse } = await import(moduleUrl);
const ID = 'a'.repeat(64), NAME = 'jarvis-exec-independent', B = 1700000000000;
const ns = (offset) => String((BigInt(B) + BigInt(offset)) * 1000000n);
const raw = (e) => JSON.stringify({ Type: e.type, Action: e.action,
  Actor: { ID: e.actorId, Attributes: { name: e.actorName } }, timeNano: e.timeNano });
const sync = (e) => { e.eventsRaw = e.events.map(raw).join('\n'); return e; };
function base() {
  return sync({ cancelResolvedBeforeRelease: false, cancelOk: true, taskStatus: 'cancelled',
    executionStatus: 'cancelled', resourceState: 'stopped', executionId: 'independent',
    resourceName: NAME, containerName: NAME, containerId: ID, sawContainerRunning: true,
    observedStates: ['running'], eventsOk: true, eventsParseErrors: [],
    events: ['create','start','die','destroy'].map((action, i) => ({ type: 'container', action,
      actorId: ID, actorName: NAME, timeNano: ns(400 + i * 100) })),
    startedAt: B, barrierAt: B+100, cancelRequestedAt: B+200, releaseAt: B+300,
    cancelResolvedAt: B+800, finalStateAt: B+900, ps: { ok: true, stdout: '' },
    inspectAfter: { ok: false, status: 1, trustedGone: true }, gitHeadBefore: 'aaa', gitHeadAfter: 'aaa' });
}
function rejected(e) { const r = check(e); assert.equal(r.ok, false, JSON.stringify(r)); assert.ok(r.failures.length); }
test('B05 positive independent lifecycle control', () => assert.equal(check(base()).ok, true));
for (const [name, mutate] of [
  ['Actor.ID', (a) => { a[1].actorId = 'b'.repeat(64); }],
  ['name', (a) => { a[1].actorName = 'other'; }],
  ['Action', (a) => { a[1].action = 'attach'; }],
  ['time', (a) => { a[1].timeNano = ns(550); }],
  ['order', (a) => { [a[0],a[1]] = [a[1],a[0]]; }],
  ['Type', (a) => { a[1].type = 'image'; }]
]) test(`B05 same-count raw/structured mismatch ${name}`, () => {
  const e = base(), changed = structuredClone(e.events); mutate(changed);
  e.eventsRaw = changed.map(raw).join('\n'); rejected(e);
});
const row = (token) => raw(base().events[2]).replace(/"timeNano":"\d+"/, `"timeNano":${token}`);
for (const token of ['1700000000123456789', '"1700000000123456789"']) {
  test(`B05 exact large integer ${token}`, () => {
    assert.equal(parse(row(token)).timeNano, '1700000000123456789');
    assert.equal(BigInt(parse(row(token)).timeNano), 1700000000123456789n);
  });
}
for (const token of ['1700000000600000000e-9','1e18','1700000000600000000.5','-1700000000600000000',
  '"1700000000600000000junk"','"1700000000600000000e-9"','null','true','{}','[]','""','0','"0"']) {
  test(`B05 reject complete invalid timeNano token ${token}`, () => {
    const line = row(token); assert.throws(() => parse(line));
    const e = base(); e.eventsRaw = e.events.map((x,i) => i === 2 ? line : raw(x)).join('\n'); rejected(e);
  });
}
for (const [name, line] of [
  ['missing', row('1').replace(/,"timeNano":1/, '')],
  ['nested only', row('1').replace('"timeNano":1', '"nested":{"timeNano":1700000000600000000}')],
  ['duplicate', row('1700000000600000000').replace(/}$/, ',"timeNano":1700000000600000000e-9}')],
  ['escaped duplicate', row('1700000000600000000').replace(/}$/, ',"time\\u004eano":1700000000600000000}')]
]) test(`B05 reject ambiguous timestamp ${name}`, () => assert.throws(() => parse(line)));
test('B05 ignores nested timeNano and quoted text when root token is valid', () => {
  const line = row('1700000000600000000').replace(/}$/, ',"extra":{"timeNano":2},"text":"\\\"timeNano\\\":3"}');
  assert.equal(parse(line).timeNano, ns(600));
});
for (const [name, mutate] of [
  ['die after confirmation within same ms', (e) => { e.events[2].timeNano=String(BigInt(ns(800))+999999n); e.events[3].timeNano=ns(850); }],
  ['destroy after final state within same ms', (e) => { e.events[3].timeNano=String(BigInt(ns(900))+1n); }],
  ['die clearly after confirmation', (e) => { e.events[2].timeNano=ns(801); e.events[3].timeNano=ns(850); }],
  ['destroy clearly after final state', (e) => { e.events[3].timeNano=ns(901); }]
]) test(`B05 reject ${name}`, () => { const e=base(); mutate(e); rejected(sync(e)); });
for (const [name, offset] of [['exact boundary',0n],['earlier',-1n]]) {
  test(`B05 legitimate ${name} timeline`, () => {
    const e=base(); e.events[2].timeNano=String(BigInt(ns(800))+offset); e.events[3].timeNano=String(BigInt(ns(900))+offset);
    const r=check(sync(e)); assert.equal(r.ok,true,JSON.stringify(r.failures));
  });
}
for (const value of [B+0.5, Number.MAX_SAFE_INTEGER+1, -1]) {
  test(`B05 reject unreliable host timestamp ${value}`, () => { const e=base();e.finalStateAt=value;rejected(e); });
}
