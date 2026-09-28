import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { crawl } from '../src/crawler/crawler.ts';
import { Frontier, START_LEAD_MS, type HostPacing } from '../src/crawler/frontier.ts';
import { page, startFixture } from './fixture.ts';

const item = (url: string, depth = 0) => ({ url, depth, foundOn: null });

async function drain(f: Frontier): Promise<string[]> {
  const out: string[] = [];
  for (;;) {
    const it = await f.next();
    if (!it) return out;
    out.push(it.url);
    f.done(it);
  }
}

test('Frontier: reihum über Hosts, innerhalb eines Hosts Breitensuche', async () => {
  const f = new Frontier(100);
  for (const u of ['http://a.test/1', 'http://a.test/2', 'http://a.test/3', 'http://b.test/1', 'http://b.test/2']) f.add(item(u));
  assert.deepEqual(await drain(f), ['http://a.test/1', 'http://b.test/1', 'http://a.test/2', 'http://b.test/2', 'http://a.test/3']);
});

test('Frontier: Duplikatschutz, Seitenlimit und force wie bisher', async () => {
  const f = new Frontier(2);
  assert.equal(f.add(item('http://a.test/1')), true);
  assert.equal(f.add(item('http://a.test/1')), false);
  assert.equal(f.add(item('http://b.test/1')), true);
  assert.equal(f.add(item('http://c.test/1')), false, 'Limit erreicht');
  assert.equal(f.add(item('http://c.test/2'), true), true, 'Start-URL mit force');
  assert.equal(f.pending, 3);
  assert.equal(f.claim('http://a.test/1'), false);
  assert.equal(f.claim('http://d.test/weiter'), true);
  assert.equal((await drain(f)).length, 3);
});

test('Frontier: voller Host wird übersprungen, ein anderer bedient', async () => {
  const pacing: HostPacing = { perHost: 1, delayMs: () => 0, nextStart: () => 0 };
  const f = new Frontier(100, pacing);
  for (const u of ['http://a.test/1', 'http://a.test/2', 'http://b.test/1']) f.add(item(u));
  const first = await f.next();
  const second = await f.next();
  assert.equal(first?.url, 'http://a.test/1');
  assert.equal(second?.url, 'http://b.test/1', 'a.test ist mit perHost 1 belegt');
  // Dritter Aufruf wartet, bis a.test wieder frei ist.
  let third: string | undefined;
  const pending = f.next().then((it) => (third = it?.url));
  await new Promise((r) => setImmediate(r));
  assert.equal(third, undefined);
  f.done(first!);
  await pending;
  assert.equal(third, 'http://a.test/2');
});

test('Frontier: release() gibt den Host-Platz schon vor done() frei, done() zählt ihn nicht doppelt', async () => {
  const pacing: HostPacing = { perHost: 1, delayMs: () => 0, nextStart: () => 0 };
  const f = new Frontier(100, pacing);
  for (const u of ['http://a.test/1', 'http://a.test/2', 'http://a.test/3']) f.add(item(u));
  const first = (await f.next())!;
  f.release(first);
  const second = (await f.next())!;
  assert.equal(second.url, 'http://a.test/2');
  f.done(first);
  // a.test/2 hält den Platz noch – a.test/3 darf nicht kommen, obwohl first fertig ist.
  let third: string | undefined;
  const pending = f.next().then((it) => (third = it?.url));
  await new Promise((r) => setImmediate(r));
  assert.equal(third, undefined);
  f.done(second);
  await pending;
  assert.equal(third, 'http://a.test/3');
});

test('Frontier: wartet auf den Mindestabstand per Timer und liest ein später bekanntes Crawl-delay', async () => {
  const delays = new Map<string, number>();
  const pacing: HostPacing = { perHost: 5, delayMs: (h) => delays.get(h) ?? 0, nextStart: () => 0 };
  const f = new Frontier(100, pacing);
  for (const u of ['http://a.test/1', 'http://a.test/2', 'http://b.test/1']) f.add(item(u));
  assert.equal((await f.next())?.url, 'http://a.test/1');
  // Crawl-delay erst nach dem ersten Abruf bekannt – gilt trotzdem für den nächsten.
  delays.set('a.test', 300);
  assert.equal((await f.next())?.url, 'http://b.test/1', 'b.test ist sofort frei');
  const started = Date.now();
  assert.equal((await f.next())?.url, 'http://a.test/2');
  const waited = Date.now() - started;
  // Die Frontier gibt bis zu START_LEAD_MS vorher aus, den Rest wartet der HostLimiter.
  assert.ok(waited >= 300 - START_LEAD_MS - 20 && waited < 1000, `wartete ${waited} ms`);
});

test('Bulk-Modus: schneller Host ist fertig, bevor die Hälfte des langsamen durch ist', async (t) => {
  const paths = Array.from({ length: 10 }, (_, i) => `/s${i}`);
  const slow = await startFixture(Object.fromEntries(paths.map((p) => [p, { delayMs: 300, body: page({ title: p, h1: [p] }) }])));
  t.after(() => slow.close());
  const fast = await startFixture(Object.fromEntries(paths.map((p) => [p, { body: page({ title: p, h1: [p] }) }])));
  t.after(() => fast.close());
  // siteKey und HostLimiter sollen zwei Hosts sehen – gleicher Hostname mit anderem Port reicht fürs Scope nicht,
  // deshalb den schnellen Server über localhost ansprechen (wie in external.test.ts).
  const fastOrigin = fast.origin.replace('127.0.0.1', 'localhost');

  const config = parseConfig(
    {
      start: { urls: [...paths.map((p) => slow.origin + p), ...paths.map((p) => fastOrigin + p)] },
      scope: { followLinks: false },
      render: { mode: 'raw' },
      politeness: { delayMs: 0, perHost: 1, concurrency: 4 },
    },
    process.cwd(),
  );
  const order: ('slow' | 'fast')[] = [];
  const pages = await crawl(config, { onPage: (p) => order.push(p.url.startsWith(slow.origin) ? 'slow' : 'fast') });
  assert.equal(pages.length, 20);
  assert.ok(pages.every((p) => p.status === 200));
  const slowBeforeLastFast = order.slice(0, order.lastIndexOf('fast')).filter((o) => o === 'slow').length;
  assert.ok(slowBeforeLastFast < 5, `Reihenfolge: ${order.join(' ')}`);
});
