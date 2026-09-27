import { gunzipSync } from 'node:zlib';
import * as cheerio from 'cheerio';

/** Liest Sitemaps und Sitemap-Indizes (auch .gz) und liefert die enthaltenen URLs. */
export async function loadSitemap(
  url: string,
  opts: { userAgent: string; timeoutMs: number; limit?: number },
): Promise<string[]> {
  const limit = opts.limit ?? 50000;
  const out: string[] = [];
  const queue = [url];
  const seen = new Set<string>();

  while (queue.length && out.length < limit) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);

    const res = await fetch(current, {
      headers: { 'user-agent': opts.userAgent },
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) throw new Error(`${current}: HTTP ${res.status}`);
    let buf = Buffer.from(await res.arrayBuffer());
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);

    const $ = cheerio.load(buf.toString('utf8'), { xml: true });
    if ($('sitemapindex').length) {
      $('sitemap > loc').each((_, e) => {
        queue.push($(e).text().trim());
      });
    } else {
      $('url > loc').each((_, e) => {
        if (out.length < limit) out.push($(e).text().trim());
      });
    }
  }
  return out;
}
