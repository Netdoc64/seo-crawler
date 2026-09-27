import * as cheerio from 'cheerio';
import type { Image, Link, Snapshot } from './types.ts';
import { normalizeUrl, siteKey } from './url.ts';

function clean(text: string | undefined | null): string | null {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t === '' ? null : t;
}

function relHas(rel: string | undefined, token: string): boolean {
  return (rel ?? '').toLowerCase().split(/\s+/).includes(token);
}

function collectTypes(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const n of node) collectTypes(n, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const type = obj['@type'];
  if (typeof type === 'string') out.push(type);
  else if (Array.isArray(type)) out.push(...type.filter((t): t is string => typeof t === 'string'));
  if (obj['@graph']) collectTypes(obj['@graph'], out);
}

export function extract(html: string, pageUrl: string, meta: { status: number; timeMs: number; bytes: number }): Snapshot {
  const $ = cheerio.load(html);
  const baseHref = $('base[href]').first().attr('href');
  const base = (baseHref && normalizeUrl(baseHref, pageUrl)) || pageUrl;
  const pageSite = siteKey(new URL(pageUrl).hostname);

  const metaByName = (name: string) =>
    clean(
      $('meta[name]')
        .filter((_, e) => ($(e).attr('name') ?? '').toLowerCase() === name)
        .first()
        .attr('content'),
    );

  const canonicalHref = $('link[rel]')
    .filter((_, e) => relHas($(e).attr('rel'), 'canonical'))
    .first()
    .attr('href');

  const headings = $('h1,h2,h3,h4,h5,h6')
    .map((_, e) => ({ level: Number(e.tagName.slice(1)), text: clean($(e).text()) ?? '' }))
    .get();

  const hreflang = $('link[hreflang]')
    .filter((_, e) => relHas($(e).attr('rel'), 'alternate'))
    .map((_, e) => ({ lang: $(e).attr('hreflang') ?? '', href: normalizeUrl($(e).attr('href') ?? '', base) ?? '' }))
    .get();

  const og: Record<string, string> = {};
  $('meta[property^="og:"]').each((_, e) => {
    const key = $(e).attr('property');
    const value = clean($(e).attr('content'));
    if (key && value) og[key] = value;
  });

  const jsonLdTypes: string[] = [];
  let jsonLdErrors = 0;
  $('script[type="application/ld+json"]').each((_, e) => {
    try {
      collectTypes(JSON.parse($(e).text()), jsonLdTypes);
    } catch {
      jsonLdErrors++;
    }
  });

  const links: Link[] = [];
  $('a[href]').each((_, e) => {
    const href = normalizeUrl($(e).attr('href') ?? '', base);
    if (!href) return;
    const rel = ($(e).attr('rel') ?? '').toLowerCase();
    links.push({
      href,
      text: clean($(e).text()) ?? '',
      rel,
      internal: siteKey(new URL(href).hostname) === pageSite,
      nofollow: relHas(rel, 'nofollow'),
    });
  });

  const images: Image[] = $('img')
    .map((_, e) => {
      const src = $(e).attr('src') ?? $(e).attr('data-src') ?? '';
      return { src: normalizeUrl(src, base) ?? src, alt: $(e).attr('alt') ?? null };
    })
    .get();

  const snapshot: Snapshot = {
    ...meta,
    title: clean($('title').first().text()),
    metaDescription: metaByName('description'),
    metaRobots: metaByName('robots'),
    canonical: canonicalHref ? normalizeUrl(canonicalHref, base) : null,
    lang: clean($('html').attr('lang')),
    h1: headings.filter((h) => h.level === 1).map((h) => h.text),
    headings,
    hreflang,
    og,
    jsonLdTypes,
    jsonLdErrors,
    links,
    images,
    wordCount: 0,
  };

  // Zuletzt, weil es das Dokument verändert.
  $('script,style,noscript,template,svg').remove();
  snapshot.wordCount = $('body').text().split(/\s+/).filter(Boolean).length;
  return snapshot;
}

/** Sieht das rohe HTML nach einer JS-App aus, deren Inhalt erst im Browser entsteht? */
export function needsRender(raw: Snapshot, html: string): boolean {
  if (/<div[^>]+id=["'](app|root|__next|__nuxt|___gatsby)["'][^>]*>\s*<\/div>/i.test(html)) return true;
  return raw.wordCount < 50 || raw.links.length < 2;
}
