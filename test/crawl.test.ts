import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { parseConfig } from '../src/config.ts';
import { crawl } from '../src/crawler/crawler.ts';
import { runRules } from '../src/rules/engine.ts';
import { loadRules } from '../src/rules/load.ts';
import type { Finding } from '../src/types.ts';
import { startFixture } from './fixture.ts';

const hasFinding = (findings: Finding[], ruleId: string, path: string) =>
  findings.some((f) => f.ruleId === ruleId && new URL(f.url).pathname === path);

test('roher Crawl: Status, Weiterleitung, robots.txt und Grundregeln', async (t) => {
  const fx = await startFixture();
  t.after(() => fx.close());

  const config = parseConfig(
    { start: { urls: [`${fx.origin}/`] }, render: { mode: 'raw' }, politeness: { delayMs: 0 } },
    process.cwd(),
  );
  const pages = await crawl(config);
  const byPath = new Map(pages.map((p) => [new URL(p.url).pathname, p]));

  assert.equal(byPath.get('/fehlt')?.status, 404);
  assert.equal(byPath.get('/privat')?.robotsBlocked, true);
  assert.deepEqual(byPath.get('/alt')?.redirects.map((h) => h.status), [301]);
  assert.equal(byPath.get('/alt')?.finalUrl, `${fx.origin}/a`);
  assert.equal(byPath.get('/')?.raw?.canonical, `${fx.origin}/`);

  const findings = runRules(pages, await loadRules(config));
  assert.ok(hasFinding(findings, 'status-ok', '/fehlt'));
  assert.ok(hasFinding(findings, 'duplicate-title', '/a'));
  assert.ok(hasFinding(findings, 'duplicate-title', '/b'));
  assert.ok(hasFinding(findings, 'broken-internal-link', '/'));
  assert.ok(hasFinding(findings, 'redirecting-internal-link', '/'));
  assert.ok(hasFinding(findings, 'h1-single', '/a'));
  assert.ok(hasFinding(findings, 'meta-description', '/b'));
  assert.ok(hasFinding(findings, 'image-alt', '/'));
  assert.ok(!hasFinding(findings, 'canonical', '/'), 'Startseite hat ein gültiges Canonical');
  assert.ok(!findings.some((f) => new URL(f.url).pathname === '/privat'), 'gesperrte Seite wird nicht bewertet');
});

test('Rendern erkennt Inhalte, die erst per JavaScript entstehen', async (t) => {
  try {
    await (await chromium.launch()).close();
  } catch {
    t.skip('Chromium nicht installiert – npm run setup');
    return;
  }
  const fx = await startFixture();
  t.after(() => fx.close());

  const config = parseConfig(
    {
      start: { urls: [`${fx.origin}/js`] },
      scope: { followLinks: false },
      render: { mode: 'auto', waitUntil: 'load' },
      politeness: { delayMs: 0 },
    },
    process.cwd(),
  );
  const [page] = await crawl(config);
  assert.ok(page);
  assert.equal(page.raw?.title, 'Lädt…');
  assert.ok(page.rendered, 'auto-Modus rendert die leere App-Hülle');
  assert.equal(page.rendered.title, 'Per JavaScript gesetzter Titel der Seite');
  assert.deepEqual(page.rendered.h1, ['JS-Überschrift']);

  const findings = runRules([page], await loadRules(config));
  assert.ok(hasFinding(findings, 'js-dependent-title', '/js'));
  assert.ok(hasFinding(findings, 'js-dependent-h1', '/js'));
});
