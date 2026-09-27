import { readFile } from 'node:fs/promises';
import type { Config } from '../config.ts';
import { extract, needsRender } from '../extract.ts';
import type { PageResult } from '../types.ts';
import { globToRegExp, isHtml, normalizeUrl, siteKey } from '../url.ts';
import { errMsg, HostLimiter, Semaphore } from '../util.ts';
import { fetchPage } from './fetcher.ts';
import { Frontier, type QueueItem } from './frontier.ts';
import { Renderer } from './renderer.ts';
import { RobotsCache } from './robots.ts';
import { loadSitemap } from './sitemap.ts';

export interface CrawlHooks {
  onPage?(page: PageResult, progress: { done: number; queued: number }): void;
  onWarn?(message: string): void;
}

async function collectSeeds(config: Config, warn: (m: string) => void): Promise<string[]> {
  const raw = [...config.start.urls];
  if (config.start.urlFile) {
    const lines = (await readFile(config.start.urlFile, 'utf8')).split(/\r?\n/).map((l) => l.trim());
    raw.push(...lines.filter((l) => l && !l.startsWith('#')));
  }
  for (const sitemap of config.start.sitemaps) {
    try {
      raw.push(...(await loadSitemap(sitemap, config.politeness)));
    } catch (err) {
      warn(`Sitemap ${sitemap}: ${errMsg(err)}`);
    }
  }
  const seeds: string[] = [];
  for (const url of raw) {
    const n = normalizeUrl(url);
    if (n) seeds.push(n);
    else warn(`ungültige URL übersprungen: ${url}`);
  }
  return seeds;
}

export async function crawl(config: Config, hooks: CrawlHooks = {}): Promise<PageResult[]> {
  const pol = config.politeness;
  const warn = hooks.onWarn ?? (() => {});
  const seeds = await collectSeeds(config, warn);
  if (seeds.length === 0) throw new Error('Keine Start-URLs – urls, urlFile oder sitemaps angeben.');

  const sites = new Set(
    (config.scope.hosts.length ? config.scope.hosts : seeds.map((u) => new URL(u).hostname)).map(siteKey),
  );
  const include = config.scope.include.map(globToRegExp);
  const exclude = config.scope.exclude.map(globToRegExp);
  const inScope = (url: string) => {
    const u = new URL(url);
    if (!sites.has(siteKey(u.hostname))) return false;
    if (include.length && !include.some((r) => r.test(u.pathname))) return false;
    return !exclude.some((r) => r.test(u.pathname));
  };

  const frontier = new Frontier(config.scope.maxPages);
  for (const url of seeds) frontier.add({ url, depth: 0, foundOn: null }, true);

  const robots = new RobotsCache(pol.userAgent, pol.timeoutMs);
  const limiter = new HostLimiter(pol.perHost, pol.delayMs);
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
        frontier.done();
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: pol.concurrency }, () => worker()));
  } finally {
    await renderer?.close();
  }
  return results;
}
