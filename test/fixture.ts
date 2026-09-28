import http from 'node:http';
import type { AddressInfo } from 'node:net';

interface Fixture {
  status?: number;
  type?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Abweichender Status für HEAD (z. B. 405 – Server verweigert HEAD). */
  headStatus?: number;
  /** Antwort nur beim ersten Abruf dieses Pfads (z. B. einmal 429, dann normal). */
  once?: { status: number; headers?: Record<string, string>; body?: string };
  /** Antwort erst nach dieser Wartezeit (langsamer Server). */
  delayMs?: number;
}

const LOREM = 'Frische Blumen werden täglich gebunden und schnell geliefert. '.repeat(30);

export function page(o: { title: string; desc?: string; h1?: string[]; links?: string[]; head?: string; body?: string }): string {
  return `<!doctype html><html lang="de"><head><title>${o.title}</title>
${o.desc ? `<meta name="description" content="${o.desc}">` : ''}${o.head ?? ''}</head><body>
${(o.h1 ?? []).map((h) => `<h1>${h}</h1>`).join('')}
${(o.links ?? []).map((l) => `<a href="${l}">${l}</a>`).join(' ')}
${o.body ?? `<p>${LOREM}</p>`}
</body></html>`;
}

const DESC = 'Eine ausreichend lange Beschreibung für die Suchergebnisse, damit keine Längenregel greift.';

const PAGES: Record<string, Fixture> = {
  '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /privat\n' },
  '/': {
    body: page({
      title: 'Startseite – Beispielshop für frische Blumen',
      desc: DESC,
      h1: ['Willkommen'],
      links: ['/a', '/b', '/alt', '/fehlt', '/privat', '/js'],
      head: '<link rel="canonical" href="/">',
      body: `<p>${LOREM}</p><img src="/bild.jpg">`,
    }),
  },
  '/a': { body: page({ title: 'Doppelter Titel für zwei verschiedene Seiten', desc: DESC, h1: ['Eins', 'Zwei'], links: ['/'] }) },
  '/b': { body: page({ title: 'Doppelter Titel für zwei verschiedene Seiten', h1: ['B'], links: ['/'] }) },
  '/alt': { status: 301, headers: { location: '/a' } },
  '/privat': { body: page({ title: 'Privat', h1: ['Privat'] }) },
  // Canonical-Ziele (T3): Quellseiten zeigen per Canonical auf fehlerhafte Ziele.
  '/can-404': { body: page({ title: 'Canonical auf Fehlerseite', desc: DESC, h1: ['C1'], head: '<link rel="canonical" href="/fehlt">' }) },
  '/can-redirect': { body: page({ title: 'Canonical auf Weiterleitung', desc: DESC, h1: ['C2'], head: '<link rel="canonical" href="/alt">' }) },
  '/can-noindex': { body: page({ title: 'Canonical auf noindex', desc: DESC, h1: ['C3'], head: '<link rel="canonical" href="/noindex-ziel">' }) },
  '/noindex-ziel': {
    body: page({
      title: 'Noindex-Zielseite',
      desc: DESC,
      h1: ['N'],
      head: '<meta name="robots" content="noindex"><link rel="canonical" href="/noindex-ziel">',
    }),
  },
  '/can-chain': { body: page({ title: 'Canonical-Kette Anfang', desc: DESC, h1: ['C4'], head: '<link rel="canonical" href="/can-mitte">' }) },
  '/can-mitte': { body: page({ title: 'Canonical-Kette Mitte', desc: DESC, h1: ['C5'], head: '<link rel="canonical" href="/a">' }) },
  '/loop-a': { body: page({ title: 'Schleife A', desc: DESC, h1: ['LA'], head: '<link rel="canonical" href="/loop-b">' }) },
  '/loop-b': { body: page({ title: 'Schleife B', desc: DESC, h1: ['LB'], head: '<link rel="canonical" href="/loop-a">' }) },
  '/can-unknown': { body: page({ title: 'Canonical ins Ungewisse', desc: DESC, h1: ['C6'], head: '<link rel="canonical" href="/nicht-gecrawlt">' }) },
  // XSS-Probe (T2): Title mit Script-Tag darf im HTML-Bericht nicht ausführbar werden.
  '/xss': { body: page({ title: '<script>alert(1)</script>', desc: DESC, h1: ['XSS'] }) },
  // hreflang (T4): korrektes Paar, Paar ohne Rückverweis, ungültiger Code, fehlender Selbstverweis.
  '/hl-de': {
    body: page({
      title: 'hreflang Deutsch korrekt',
      desc: DESC,
      h1: ['DE'],
      head: '<link rel="alternate" hreflang="de" href="/hl-de"><link rel="alternate" hreflang="en" href="/hl-en"><link rel="alternate" hreflang="x-default" href="/hl-de">',
    }),
  },
  '/hl-en': {
    body: page({
      title: 'hreflang English correct',
      desc: DESC,
      h1: ['EN'],
      head: '<link rel="alternate" hreflang="en" href="/hl-en"><link rel="alternate" hreflang="de" href="/hl-de"><link rel="alternate" hreflang="x-default" href="/hl-de">',
    }),
  },
  '/hl-einseitig': {
    body: page({
      title: 'hreflang ohne Rückverweis',
      desc: DESC,
      h1: ['Einseitig'],
      head: '<link rel="alternate" hreflang="de" href="/hl-einseitig"><link rel="alternate" hreflang="en" href="/hl-en">',
    }),
  },
  '/hl-code': {
    body: page({
      title: 'hreflang mit ungültigem Code',
      desc: DESC,
      h1: ['Code'],
      head: '<link rel="alternate" hreflang="english" href="/hl-code">',
    }),
  },
  '/hl-selbst': {
    body: page({
      title: 'hreflang ohne Selbstverweis',
      desc: DESC,
      h1: ['Selbst'],
      head: '<link rel="alternate" hreflang="en" href="/hl-en">',
    }),
  },
  // Verwaist/Sitemap (T5): eigener Zweig, damit die anderen Tests unberührt bleiben.
  '/sitemap.xml': {
    type: 'application/xml',
    // __ORIGIN__ wird beim Ausliefern durch den echten Origin ersetzt – Sitemap-loc muss absolut sein.
    body: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>__ORIGIN__/sm-start</loc></url>
  <url><loc>__ORIGIN__/sm-verwaist</loc></url>
</urlset>`,
  },
  '/sm-start': {
    body: page({
      title: 'Sitemap-Test Startseite mit ausreichend langem Titel',
      desc: DESC,
      h1: ['SM'],
      links: ['/sm-verlinkt'],
      head: '<link rel="canonical" href="/sm-start">',
    }),
  },
  '/sm-verlinkt': {
    body: page({
      title: 'Verlinkt, aber nicht in der Sitemap',
      desc: DESC,
      h1: ['Verlinkt'],
      links: ['/sm-start'],
      head: '<link rel="canonical" href="/sm-verlinkt">',
    }),
  },
  '/sm-verwaist': {
    body: page({
      title: 'In der Sitemap, aber unverlinkt',
      desc: DESC,
      h1: ['Verwaist'],
      head: '<link rel="canonical" href="/sm-verwaist">',
    }),
  },
  '/js': {
    body: page({
      title: 'Lädt…',
      body: `<div id="app"></div><script>
        document.title = 'Per JavaScript gesetzter Titel der Seite';
        const h = document.createElement('h1');
        h.textContent = 'JS-Überschrift';
        document.getElementById('app').appendChild(h);
      </script>`,
    }),
  },
};

export async function startFixture(
  extra: Record<string, Fixture> = {},
): Promise<{ origin: string; hits: string[]; close(): Promise<void> }> {
  const pages: Record<string, Fixture> = { ...PAGES, ...extra };
  const hits: string[] = [];
  const onceUsed = new Set<string>();
  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    hits.push(`${req.method} ${path}`);
    const f = pages[path];
    if (f?.delayMs) await new Promise((resolve) => setTimeout(resolve, f.delayMs));
    if (!f) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page({ title: 'Nicht gefunden', h1: ['404'] }));
      return;
    }
    if (f.once && !onceUsed.has(path)) {
      onceUsed.add(path);
      res.writeHead(f.once.status, { 'content-type': 'text/html; charset=utf-8', ...f.once.headers });
      res.end(f.once.body ?? '');
      return;
    }
    const status = req.method === 'HEAD' && f.headStatus !== undefined ? f.headStatus : (f.status ?? 200);
    res.writeHead(status, { 'content-type': `${f.type ?? 'text/html'}; charset=utf-8`, ...f.headers });
    res.end(req.method === 'HEAD' ? '' : (f.body ?? '').replaceAll('__ORIGIN__', origin));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
