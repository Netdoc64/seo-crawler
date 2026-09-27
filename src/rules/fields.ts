import type { PageResult, Snapshot } from '../types.ts';
import type { Fields } from './schema.ts';

/**
 * Alles, was eine Regel über `field` ansprechen kann: die Snapshot-Felder plus abgeleitete Werte.
 * Verschachtelte Werte per Punkt, z. B. `headers.x-robots-tag` oder `og.og:title`.
 */
export function pageFields(p: PageResult, s: Snapshot | null): Fields {
  const xRobotsTag = p.headers['x-robots-tag'] ?? null;
  const robots = [s?.metaRobots, xRobotsTag].filter(Boolean).join(',').toLowerCase();
  const noindex = /\b(noindex|none)\b/.test(robots);
  const canonicalIsSelf = s?.canonical ? s.canonical === p.finalUrl : null;
  return {
    ...s,
    url: p.url,
    finalUrl: p.finalUrl,
    path: new URL(p.finalUrl).pathname,
    depth: p.depth,
    status: p.status,
    contentType: p.contentType,
    headers: p.headers,
    redirects: p.redirects,
    redirectCount: p.redirects.length,
    error: p.error,
    renderError: p.renderError,
    rendered: p.rendered !== null,
    timeMs: s?.timeMs ?? null,
    xRobotsTag,
    noindex,
    canonicalIsSelf,
    indexable: p.status >= 200 && p.status < 300 && !noindex && canonicalIsSelf !== false,
    h1Count: s?.h1.length ?? 0,
    imagesMissingAlt: s ? s.images.filter((i) => i.alt === null).length : 0,
    internalLinks: s ? s.links.filter((l) => l.internal).length : 0,
    externalLinks: s ? s.links.filter((l) => !l.internal).length : 0,
  };
}

export function effectiveFields(p: PageResult): Fields {
  return pageFields(p, p.rendered ?? p.raw);
}

export function getPath(obj: Fields, path: string): unknown {
  if (path in obj) return obj[path];
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}
