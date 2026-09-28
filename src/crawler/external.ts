import type { PageResult } from '../types.ts';
import { normalizeUrl } from '../url.ts';
import { HostLimiter, sleep } from '../util.ts';
import { fetchPage, type FetchResult } from './fetcher.ts';

export interface ExternalCheckOptions {
  userAgent: string;
  timeoutMs: number;
  perHost: number;
  delayMs: number;
}

/** 429: höchstens so lange auf Retry-After warten. */
const RETRY_AFTER_MAX_MS = 30_000;

function toPageResult(url: string, res: FetchResult): PageResult {
  return {
    url,
    finalUrl: normalizeUrl(res.finalUrl) ?? res.finalUrl,
    depth: -1,
    foundOn: null,
    status: res.status,
    contentType: res.contentType,
    headers: res.headers,
    redirects: res.redirects,
    robotsBlocked: false,
    duplicateOf: null,
    error: res.error,
    renderError: null,
    raw: null,
    rendered: null,
    external: true,
  };
}

/**
 * Prüft externe Link-Ziele nach dem Crawl – jedes genau einmal, ohne robots.txt der fremden
 * Hosts (einzelner Abruf, kein Crawl) und mit denselben Höflichkeitswerten wie der Crawl.
 */
export async function checkExternalLinks(urls: string[], opts: ExternalCheckOptions): Promise<PageResult[]> {
  const limiter = new HostLimiter(opts.perHost, opts.delayMs);
  const base = { userAgent: opts.userAgent, timeoutMs: opts.timeoutMs, readBody: false };
  return Promise.all(
    urls.map(async (url) => {
      const host = new URL(url).host;
      let res = await limiter.run(host, () => fetchPage(url, { ...base, method: 'HEAD' }));
      // Manche Server verweigern HEAD (405/501) oder brechen bei HEAD ab – dann einmal GET.
      if (res.status === 405 || res.status === 501 || res.status === 0) {
        res = await limiter.run(host, () => fetchPage(url, { ...base, method: 'GET' }));
      }
      // 429 mit Retry-After: einmal nach der Wartezeit wiederholen, sonst als 429 melden.
      if (res.status === 429) {
        const retryAfterMs = Number(res.headers['retry-after']) * 1000;
        if (Number.isFinite(retryAfterMs) && retryAfterMs > 0 && retryAfterMs <= RETRY_AFTER_MAX_MS) {
          await sleep(retryAfterMs);
          res = await limiter.run(host, () => fetchPage(url, { ...base, method: 'GET' }));
        }
      }
      return toPageResult(url, res);
    }),
  );
}
