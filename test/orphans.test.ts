import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { crawl } from '../src/crawler/crawler.ts';
import { runRules } from '../src/rules/engine.ts';
import { loadRules } from '../src/rules/load.ts';
import { startFixture } from './fixture.ts';

const on = (findings: { ruleId: string; url: string; message: string }[], ruleId: string, path: string) =>
  findings.filter((f) => f.ruleId === ruleId && new URL(f.url).pathname === path);

test('Verwaiste Sitemap-Seiten und fehlende Sitemap-Einträge', async (t) => {
  const fx = await startFixture();
  t.after(() => fx.close());

  const config = parseConfig(
    {
      start: { urls: [`${fx.origin}/sm-start`], sitemaps: [`${fx.origin}/sitemap.xml`] },
      render: { mode: 'raw' },
      politeness: { delayMs: 0 },
    },
    process.cwd(),
  );
  const pages = await crawl(config);
  const sitemapUrls = new Set([`${fx.origin}/sm-start`, `${fx.origin}/sm-verwaist`]);
  const findings = runRules(pages, await loadRules(config), { sitemapUrls, followLinks: config.scope.followLinks });

  // /sm-verwaist kam per Sitemap, kein Link zeigt darauf.
  const orphans = on(findings, 'orphan-from-sitemap', '/sm-verwaist');
  assert.equal(orphans.length, 1);
  assert.match(orphans[0]!.message, /Sitemap/);

  // /sm-start kam als url (gewinnt vor sitemap) und ist verlinkt → nicht verwaist.
  assert.equal(on(findings, 'orphan-from-sitemap', '/sm-start').length, 0);
  assert.equal(on(findings, 'orphan-from-sitemap', '/sm-verlinkt').length, 0);

  // /sm-verlinkt ist indexierbar und steht nicht in der Sitemap.
  const missing = on(findings, 'missing-from-sitemap', '/sm-verlinkt');
  assert.equal(missing.length, 1);

  // /sm-start kam per Sitemap (auch als url) → nicht „fehlend“.
  assert.equal(on(findings, 'missing-from-sitemap', '/sm-start').length, 0);
});

test('Ohne Linkverfolgung keine Verwaist-Befunde, ohne Sitemap keine Fehlt-Befunde', async (t) => {
  const fx = await startFixture();
  t.after(() => fx.close());

  const noFollow = parseConfig(
    {
      start: { urls: [`${fx.origin}/sm-start`], sitemaps: [`${fx.origin}/sitemap.xml`] },
      scope: { followLinks: false },
      render: { mode: 'raw' },
      politeness: { delayMs: 0 },
    },
    process.cwd(),
  );
  const pages = await crawl(noFollow);
  const sitemapUrls = new Set([`${fx.origin}/sm-start`, `${fx.origin}/sm-verwaist`]);
  const findings = runRules(pages, await loadRules(noFollow), { sitemapUrls, followLinks: false });
  assert.equal(findings.filter((f) => f.ruleId === 'orphan-from-sitemap').length, 0);

  const noSitemap = parseConfig(
    { start: { urls: [`${fx.origin}/sm-start`] }, render: { mode: 'raw' }, politeness: { delayMs: 0 } },
    process.cwd(),
  );
  const pages2 = await crawl(noSitemap);
  const findings2 = runRules(pages2, await loadRules(noSitemap), { sitemapUrls: null, followLinks: true });
  assert.equal(findings2.filter((f) => f.ruleId === 'missing-from-sitemap').length, 0);
});
