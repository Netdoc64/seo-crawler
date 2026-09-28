import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { crawl } from '../src/crawler/crawler.ts';
import { runRules } from '../src/rules/engine.ts';
import { loadRules } from '../src/rules/load.ts';
import { page, startFixture } from './fixture.ts';

async function setup(t: import('node:test').TestContext) {
  // Zweiter Server als „fremder Host“. Nur ein anderer Port reicht nicht – siteKey vergleicht Hostnamen –,
  // deshalb wird er über localhost statt 127.0.0.1 angesprochen.
  const foreign = await startFixture({
    '/ok': { body: page({ title: 'OK', h1: ['ok'] }) },
    '/kaputt': { status: 404, body: page({ title: 'weg', h1: ['404'] }) },
    '/head-nein': { headStatus: 405, body: page({ title: 'HEAD verweigert', h1: ['405'] }) },
    '/gesperrt': { status: 403, body: '' },
    '/limit': { once: { status: 429, headers: { 'retry-after': '1' } }, body: page({ title: 'danach ok', h1: ['ok'] }) },
  });
  t.after(() => foreign.close());
  const main = await startFixture({
    '/ext': {
      body: page({
        title: 'Seite mit vielen externen Links',
        h1: ['ext'],
        links: ['/ok', '/kaputt', '/head-nein', '/gesperrt', '/limit'].map(
          (p) => `${foreign.origin.replace('127.0.0.1', 'localhost')}${p}`,
        ),
      }),
    },
  });
  t.after(() => main.close());
  return { foreign, main };
}

test('Externe Links: 404 kaputt, 403 blockiert, HEAD-Verweigerung und 429-Retry ok', async (t) => {
  const { main } = await setup(t);
  const config = parseConfig(
    {
      start: { urls: [`${main.origin}/ext`] },
      scope: { followLinks: false, checkExternal: true },
      render: { mode: 'raw' },
      politeness: { delayMs: 0 },
    },
    process.cwd(),
  );
  const pages = await crawl(config);

  const external = pages.filter((p) => p.external);
  assert.equal(external.length, 5);
  assert.ok(external.every((p) => p.depth === -1 && p.raw === null && p.rendered === null));

  const findings = runRules(pages, await loadRules(config));
  const broken = findings.filter((f) => f.ruleId === 'broken-external-link');
  assert.equal(broken.length, 1);
  assert.match(broken[0]!.message, /\/kaputt → 404/);
  assert.equal(new URL(broken[0]!.url).pathname, '/ext', 'Befund hängt an der verlinkenden Seite');

  const blocked = findings.filter((f) => f.ruleId === 'external-link-blocked');
  assert.equal(blocked.length, 1);
  assert.match(blocked[0]!.message, /\/gesperrt/);

  // Keine Befunde für ok, HEAD→GET-Fallback und 429 mit Retry-After.
  assert.ok(!broken.some((f) => /\/ok|\/head-nein|\/limit/.test(f.message)));
});

test('Ohne checkExternal wird kein einziges externes Ziel abgerufen', async (t) => {
  const { foreign, main } = await setup(t);
  const config = parseConfig(
    {
      start: { urls: [`${main.origin}/ext`] },
      scope: { followLinks: false },
      render: { mode: 'raw' },
      politeness: { delayMs: 0 },
    },
    process.cwd(),
  );
  const pages = await crawl(config);
  assert.equal(pages.filter((p) => p.external).length, 0);
  assert.deepEqual(foreign.hits, []);
});

test('maxExternal begrenzt die Prüfung und warnt mit den ausgelassenen Zielen', async (t) => {
  const { main } = await setup(t);
  const config = parseConfig(
    {
      start: { urls: [`${main.origin}/ext`] },
      scope: { followLinks: false, checkExternal: true, maxExternal: 2 },
      render: { mode: 'raw' },
      politeness: { delayMs: 0 },
    },
    process.cwd(),
  );
  const warnings: string[] = [];
  const pages = await crawl(config, { onWarn: (m) => warnings.push(m) });
  assert.equal(pages.filter((p) => p.external).length, 2);
  assert.ok(warnings.some((w) => /maxExternal 2 erreicht/.test(w) && /nicht geprüft/.test(w)));
});
