import http from 'node:http';
import type { AddressInfo } from 'node:net';

interface Fixture {
  status?: number;
  type?: string;
  headers?: Record<string, string>;
  body?: string;
}

const LOREM = 'Frische Blumen werden täglich gebunden und schnell geliefert. '.repeat(30);

function page(o: { title: string; desc?: string; h1?: string[]; links?: string[]; head?: string; body?: string }): string {
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

export async function startFixture(): Promise<{ origin: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const f = PAGES[(req.url ?? '/').split('?')[0]!];
    if (!f) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page({ title: 'Nicht gefunden', h1: ['404'] }));
      return;
    }
    res.writeHead(f.status ?? 200, { 'content-type': `${f.type ?? 'text/html'}; charset=utf-8`, ...f.headers });
    res.end(f.body ?? '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
