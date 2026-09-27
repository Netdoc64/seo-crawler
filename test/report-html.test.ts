import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { crawl } from '../src/crawler/crawler.ts';
import { summarize } from '../src/report.ts';
import { formatHtml } from '../src/report-html.ts';
import { runRules } from '../src/rules/engine.ts';
import { loadRules } from '../src/rules/load.ts';
import { startFixture } from './fixture.ts';

test('HTML-Bericht: XSS-sicher, alle Regeln, keine externen Ressourcen', async (t) => {
  const fx = await startFixture();
  t.after(() => fx.close());

  const config = parseConfig(
    { start: { urls: [`${fx.origin}/xss`] }, scope: { followLinks: false }, render: { mode: 'raw' }, politeness: { delayMs: 0 } },
    process.cwd(),
  );
  const pages = await crawl(config);
  const rules = await loadRules(config);
  const findings = runRules(pages, rules);
  const summary = summarize(1, 'testlauf', pages, findings);
  const descriptions = Object.fromEntries([...rules.page, ...rules.site].map((r) => [r.id, r.description ?? '']));
  const html = formatHtml({ summary, pages, descriptions, generatedAt: '2026-09-27T00:00:00.000Z' });

  // Der Fixture-Title enthält <script>alert(1)</script> – er darf nirgends unescapt auftauchen.
  assert.ok(!html.includes('<script>alert(1)</script>'), 'unescapter Fixture-Title im HTML');
  assert.ok(html.includes('&#60;script&#62;alert(1)'), 'Title muss escaped vorkommen');

  // Jede Regel mit Befund steht in der Regeltabelle.
  for (const r of summary.rules) assert.ok(html.includes(r.ruleId), `Regel ${r.ruleId} fehlt`);

  // Keine externen Ressourcen: kein script/link mit http(s)-Quelle.
  assert.ok(!/<(script|link)[^>]+(src|href)="https?:\/\//i.test(html), 'externe Ressource gefunden');

  // Eingebettetes JSON darf kein schließendes </script> aus Daten erzeugen können.
  const jsonBlock = html.match(/<script type="application\/json" id="daten">(.*?)<\/script>/s)?.[1] ?? '';
  assert.ok(!jsonBlock.includes('</'), 'rohes </ im eingebetteten JSON');
});

test('HTML-Bericht: leerer Lauf zeigt Hinweis statt leerer Tabelle', () => {
  const summary = summarize(2, 'leer', [], []);
  const html = formatHtml({ summary, pages: [], generatedAt: '2026-09-27T00:00:00.000Z' });
  assert.ok(html.includes('Keine Befunde'), 'Hinweis fehlt');
  assert.ok(!/<(script|link)[^>]+(src|href)="https?:\/\//i.test(html));
});
