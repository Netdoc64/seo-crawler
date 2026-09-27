import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { crawl } from '../src/crawler/crawler.ts';
import { runRules } from '../src/rules/engine.ts';
import { loadRules } from '../src/rules/load.ts';
import { startFixture } from './fixture.ts';

test('canonical-target: fehlerhafte Canonical-Ziele werden je einmal gemeldet', async (t) => {
  const fx = await startFixture();
  t.after(() => fx.close());

  const paths = [
    '/can-404',
    '/can-redirect',
    '/can-noindex',
    '/noindex-ziel',
    '/can-chain',
    '/can-mitte',
    '/loop-a',
    '/loop-b',
    '/can-unknown',
    '/fehlt',
    '/alt',
    '/a',
  ];
  const config = parseConfig(
    { start: { urls: paths.map((p) => `${fx.origin}${p}`) }, render: { mode: 'raw' }, politeness: { delayMs: 0 } },
    process.cwd(),
  );
  const pages = await crawl(config);
  const findings = runRules(pages, await loadRules(config)).filter((f) => f.ruleId === 'canonical-target');
  const on = (path: string) => findings.filter((f) => new URL(f.url).pathname === path);

  const notFound = on('/can-404');
  assert.equal(notFound.length, 1);
  assert.match(notFound[0]!.message, /\/fehlt \(404\)/);

  const redirect = on('/can-redirect');
  assert.equal(redirect.length, 1);
  assert.match(redirect[0]!.message, /Weiterleitung nach .*\/a/);

  const noindex = on('/can-noindex');
  assert.equal(noindex.length, 1);
  assert.match(noindex[0]!.message, /noindex-Seite .*\/noindex-ziel/);

  const chain = on('/can-chain');
  assert.equal(chain.length, 1);
  assert.match(chain[0]!.message, /Canonical-Kette: .*\/can-chain → .*\/can-mitte → .*\/a/);

  // Schleife a → b → a: ein Befund je Quellseite, kein Endloslauf.
  assert.equal(on('/loop-a').length, 1);
  assert.match(on('/loop-a')[0]!.message, /Canonical-Kette: .*\/loop-a → .*\/loop-b → .*\/loop-a/);
  assert.equal(on('/loop-b').length, 1);

  // Ziel nicht gecrawlt → unbekannt, kein Befund.
  assert.equal(on('/can-unknown').length, 0);

  // Die Ziele selbst und saubere Seiten bekommen keinen Befund.
  assert.equal(on('/a').length, 0);
  assert.equal(on('/can-mitte').length, 0);
});
