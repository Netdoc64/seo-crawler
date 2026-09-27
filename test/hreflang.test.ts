import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { crawl } from '../src/crawler/crawler.ts';
import { runRules } from '../src/rules/engine.ts';
import { loadRules } from '../src/rules/load.ts';
import { startFixture } from './fixture.ts';

test('hreflang: gültige Codes, Selbstverweis und Rückverweis', async (t) => {
  const fx = await startFixture();
  t.after(() => fx.close());

  const paths = ['/hl-de', '/hl-en', '/hl-einseitig', '/hl-code', '/hl-selbst'];
  const config = parseConfig(
    { start: { urls: paths.map((p) => `${fx.origin}${p}`) }, render: { mode: 'raw' }, politeness: { delayMs: 0 } },
    process.cwd(),
  );
  const pages = await crawl(config);
  const findings = runRules(pages, await loadRules(config));
  const on = (ruleId: string, path: string) =>
    findings.filter((f) => f.ruleId === ruleId && new URL(f.url).pathname === path);

  // Korrektes Paar mit Rückverweis und x-default: keine Befunde.
  assert.deepEqual(on('hreflang', '/hl-de'), []);
  assert.deepEqual(on('hreflang', '/hl-en'), []);
  assert.deepEqual(on('hreflang-x-default', '/hl-de'), []);

  // /hl-einseitig nennt /hl-en für en, aber /hl-en nennt /hl-einseitig nicht.
  const back = on('hreflang', '/hl-einseitig');
  assert.equal(back.length, 1);
  assert.match(back[0]!.message, /fehlender Rückverweis von .*\/hl-en/);

  // Ungültiger Sprachcode.
  const code = on('hreflang', '/hl-code');
  assert.equal(code.length, 1);
  assert.match(code[0]!.message, /ungültiger Sprachcode „english“/);

  // Fehlender Selbstverweis (nennt nur /hl-en, nicht sich selbst).
  const selbst = on('hreflang', '/hl-selbst');
  assert.ok(selbst.some((f) => /kein Selbstverweis/.test(f.message)));

  // Ohne x-default: eigene info-Regel.
  const xd = on('hreflang-x-default', '/hl-code');
  assert.equal(xd.length, 1);
  assert.match(xd[0]!.message, /kein x-default/);
});
