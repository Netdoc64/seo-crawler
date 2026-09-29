import { readFile } from 'node:fs/promises';
import type { Config } from '../config.ts';
import { extract, needsRender } from '../extract.ts';
import type { PageResult } from '../types.ts';
import { globToRegExp, isHtml, normalizeUrl, siteKey } from '../url.ts';
import { errMsg, HostLimiter, Semaphore } from '../util.ts';
import { checkExternalLinks } from './external.ts';
import { fetchPage } from './fetcher.ts';
import { Frontier, type QueueItem } from './frontier.ts';
import { Renderer } from './renderer.ts';
import { RobotsCache } from './robots.ts';
import { loadSitemap } from './sitemap.ts';

export interface CrawlHooks {
  onPage?(page: PageResult, progress: { done: number; queued: number }): void;
  onWarn?(message: string): void;
  /** Nach dem Sammeln der Start-URLs: alle URLs aus Sitemaps (normalisiert). */
  onSeeds?(info: { sitemapUrls: Set<string> }): void;
}

export interface Seed {
  url: string;
  source: 'url' | 'file' | 'sitemap';
}

async function collectSeeds(config: Config, warn: (m: string) => void): Promise<{ seeds: Seed[]; sitemapUrls: Set<string> }> {
  const raw: { url: string; source: Seed['source'] }[] = config.start.urls.map((url) => ({ url, source: 'url' }));
  if (config.start.urlFile) {
    const lines = (await readFile(config.start.urlFile, 'utf8')).split(/\r?\n/).map((l) => l.trim());
    raw.push(...lines.filter((l) => l && !l.startsWith('#')).map((url) => ({ url, source: 'file' as const })));
  }
  const sitemapUrls = new Set<string>();
  for (const sitemap of config.start.sitemaps) {
    try {
      for (const url of await loadSitemap(sitemap, config.politeness)) {
        raw.push({ url, source: 'sitemap' });
        const n = normalizeUrl(url);
        if (n) sitemapUrls.add(n);
      }
    } catch (err) {
      warn(`Sitemap ${sitemap}: ${errMsg(err)}`);
    }
  }
  // Eine URL in mehreren Quellen: url gewinnt vor file vor sitemap.
  const rank = { url: 0, file: 1, sitemap: 2 };
  const byUrl = new Map<string, Seed>();
  for (const { url, source } of raw) {
    const n = normalizeUrl(url);
    if (!n) {
      warn(`ungültige URL übersprungen: ${url}`);
      continue;
    }
    const known = byUrl.get(n);
    if (!known || rank[source] < rank[known.source]) byUrl.set(n, { url: n, source });
  }
  return { seeds: [...byUrl.values()], sitemapUrls };
}

export async function crawl(config: Config, hooks: CrawlHooks = {}): Promise<PageResult[]> {
  const pol = config.politeness;
  const warn = hooks.onWarn ?? (() => {});
  const { seeds, sitemapUrls } = await collectSeeds(config, warn);
  if (seeds.length === 0) throw new Error('Keine Start-URLs – urls, urlFile oder sitemaps angeben.');
  hooks.onSeeds?.({ sitemapUrls });

  const sites = new Set(
    (config.scope.hosts.length ? config.scope.hosts : seeds.map((s) => new URL(s.url).hostname)).map(siteKey),
  );
  const include = config.scope.include.map(globToRegExp);
  const exclude = config.scope.exclude.map(globToRegExp);
  const inScope = (url: string) => {
    const u = new URL(url);
    if (!sites.has(siteKey(u.hostname))) return false;
    if (include.length && !include.some((r) => r.test(u.pathname))) return false;
    return !exclude.some((r) => r.test(u.pathname));
  };

  const robots = new RobotsCache(pol.userAgent, pol.timeoutMs);
  const limiter = new HostLimiter(pol.perHost, pol.delayMs);
  // Die Frontier gibt nur URLs von Hosts aus, die der Limiter (fast) sofort starten ließe –
  // so hängt kein Worker an einem belegten Host, während ein anderer frei ist.
  const frontier = new Frontier(config.scope.maxPages, {
    perHost: pol.perHost,
    delayMs: (host) => limiter.delayMs(host),
    nextStart: (host) => limiter.nextStart(host),
  });
  for (const seed of seeds) frontier.add({ url: seed.url, depth: 0, foundOn: null, seedSource: seed.source }, true);
  const renderSlots = new Semaphore(config.render.concurrency);
  const renderer =
    config.render.mode === 'raw'
      ? null
      : new Renderer({
          userAgent: pol.userAgent,
          timeoutMs: config.render.timeoutMs,
          waitUntil: config.render.waitUntil,
          blockResources: config.render.blockResources,
        });
  if (renderer) {
    try {
      await renderer.start();
    } catch (err) {
      throw new Error(
        `Chromium startet nicht (${errMsg(err).split('\n')[0]}).\n` +
          `Einmalig „npm run setup“ ausführen oder mit --mode raw ohne Browser crawlen.`,
      );
    }
  }

  async function visit(item: QueueItem): Promise<PageResult> {
    const page: PageResult = {
      url: item.url,
      finalUrl: item.url,
      depth: item.depth,
      foundOn: item.foundOn,
      ...(item.seedSource ? { seedSource: item.seedSource } : {}),
      status: 0,
      contentType: null,
      headers: {},
      redirects: [],
      robotsBlocked: false,
      duplicateOf: null,
      error: null,
      renderError: null,
      raw: null,
      rendered: null,
    };
    const host = new URL(item.url).host;
    if (pol.respectRobots) {
      if (!(await robots.isAllowed(item.url))) {
        page.robotsBlocked = true;
        return page;
      }
      limiter.setDelay(host, await robots.crawlDelayMs(item.url));
    }

    const res = await limiter.run(host, () => fetchPage(item.url, pol));
    frontier.release(item);
    page.finalUrl = normalizeUrl(res.finalUrl) ?? res.finalUrl;
    page.status = res.status;
    page.contentType = res.contentType;
    page.headers = res.headers;
    page.redirects = res.redirects;
    page.error = res.error;

    // Ziel schon bekannt: die Weiterleitung selbst zählt, der Inhalt wird beim Ziel geprüft.
    if (page.finalUrl !== item.url && !frontier.claim(page.finalUrl)) {
      page.duplicateOf = page.finalUrl;
      return page;
    }
    if (res.body === null || !isHtml(res.contentType)) return page;

    page.raw = extract(res.body, page.finalUrl, { status: res.status, timeMs: res.timeMs, bytes: res.bytes });
    const ok = res.status >= 200 && res.status < 300;
    if (renderer && ok && (config.render.mode === 'render' || needsRender(page.raw, res.body))) {
      const finalHost = new URL(page.finalUrl).host;
      try {
        const r = await renderSlots.use(() => limiter.run(finalHost, () => renderer.render(page.finalUrl)));
        page.rendered = extract(r.html, page.finalUrl, {
          status: r.status || res.status,
          timeMs: r.timeMs,
          bytes: Buffer.byteLength(r.html),
        });
        if (r.timedOut) page.renderError = `${config.render.waitUntil} nicht erreicht, Stand nach ${config.render.timeoutMs} ms übernommen`;
      } catch (err) {
        page.renderError = errMsg(err);
        warn(`Rendern fehlgeschlagen: ${page.finalUrl}: ${page.renderError}`);
      }
    }

    const effective = page.rendered ?? page.raw;
    if (ok && config.scope.followLinks && item.depth < config.scope.maxDepth) {
      for (const link of effective.links) {
        if (inScope(link.href)) frontier.add({ url: link.href, depth: item.depth + 1, foundOn: page.finalUrl });
      }
    }
    return page;
  }

  const results: PageResult[] = [];
  async function worker() {
    for (;;) {
      const item = await frontier.next();
      if (!item) return;
      try {
        const page = await visit(item);
        results.push(page);
        hooks.onPage?.(page, { done: results.length, queued: frontier.pending });
      } catch (err) {
        warn(`${item.url}: ${errMsg(err)}`);
      } finally {
        frontier.done(item);
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: pol.concurrency }, () => worker()));
  } finally {
    await renderer?.close();
  }

  // Externe Link-Ziele erst nach dem Crawl prüfen, jedes eindeutige Ziel genau einmal.
  if (config.scope.checkExternal) {
    const targets = new Set<string>();
    for (const p of results) {
      for (const link of (p.rendered ?? p.raw)?.links ?? []) {
        if (!link.internal) targets.add(link.href);
      }
    }
    let urls = [...targets];
    if (urls.length > config.scope.maxExternal) {
      const skipped = urls.splice(config.scope.maxExternal);
      const preview = skipped.slice(0, 5).join(', ');
      warn(`maxExternal ${config.scope.maxExternal} erreicht – nicht geprüft: ${preview}${skipped.length > 5 ? ` (+${skipped.length - 5} weitere)` : ''}`);
    }
    const externalPages = await checkExternalLinks(urls, {
      userAgent: pol.userAgent,
      timeoutMs: pol.timeoutMs,
      perHost: pol.perHost,
      delayMs: pol.delayMs,
    });
    for (const ep of externalPages) {
      results.push(ep);
      hooks.onPage?.(ep, { done: results.length, queued: 0 });
    }
  }
  return results;
}
