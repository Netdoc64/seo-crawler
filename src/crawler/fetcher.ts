import type { Hop } from '../types.ts';
import { errMsg } from '../util.ts';

export interface FetchOptions {
  userAgent: string;
  timeoutMs: number;
  maxRedirects?: number;
  accept?: string;
  /** Standard GET; HEAD für reine Erreichbarkeitsprüfungen. */
  method?: 'GET' | 'HEAD';
  /** false = Body nie lesen (Status genügt, z. B. externe Links). */
  readBody?: boolean;
}

export interface FetchResult {
  url: string;
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  contentType: string | null;
  body: string | null;
  bytes: number;
  timeMs: number;
  redirects: Hop[];
  error: string | null;
}

const TEXTUAL = /^(text\/|application\/(xhtml\+xml|xml|json|ld\+json|rss\+xml|atom\+xml))/i;

/** Folgt Weiterleitungen selbst, damit jede Stufe der Kette sichtbar bleibt. */
export async function fetchPage(url: string, opts: FetchOptions): Promise<FetchResult> {
  const started = performance.now();
  const maxRedirects = opts.maxRedirects ?? 10;
  const redirects: Hop[] = [];
  const visited = new Set<string>();
  let current = url;

  const elapsed = () => Math.round(performance.now() - started);
  const fail = (error: string): FetchResult => ({
    url,
    finalUrl: current,
    status: 0,
    headers: {},
    contentType: null,
    body: null,
    bytes: 0,
    timeMs: elapsed(),
    redirects,
    error,
  });

  try {
    for (;;) {
      visited.add(current);
      const res = await fetch(current, {
        redirect: 'manual',
        method: opts.method ?? 'GET',
        headers: {
          'user-agent': opts.userAgent,
          accept: opts.accept ?? 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        redirects.push({ url: current, status: res.status });
        const next = new URL(location, current).toString();
        if (visited.has(next)) return fail(`Weiterleitungsschleife bei ${next}`);
        if (redirects.length > maxRedirects) return fail(`mehr als ${maxRedirects} Weiterleitungen`);
        current = next;
        continue;
      }

      const contentType = res.headers.get('content-type');
      let body: string | null = null;
      let bytes = 0;
      if (opts.method === 'HEAD' || opts.readBody === false) {
        const len = Number(res.headers.get('content-length'));
        bytes = Number.isFinite(len) ? len : 0;
        await res.body?.cancel();
      } else if (contentType && TEXTUAL.test(contentType)) {
        body = await res.text();
        bytes = Buffer.byteLength(body);
      } else {
        const len = Number(res.headers.get('content-length'));
        bytes = Number.isFinite(len) ? len : 0;
        await res.body?.cancel();
      }
      return {
        url,
        finalUrl: current,
        status: res.status,
        headers: Object.fromEntries(res.headers),
        contentType,
        body,
        bytes,
        timeMs: elapsed(),
        redirects,
        error: null,
      };
    }
  } catch (err) {
    return fail(errMsg(err));
  }
}
