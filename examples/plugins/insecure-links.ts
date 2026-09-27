import type { Plugin } from '../../src/rules/schema.ts';

/** Beispiel-Plugin: interne Links, die noch auf http:// zeigen, obwohl die Seite per https läuft. */
const plugin: Plugin = {
  id: 'insecure-internal-links',
  severity: 'warning',
  description: 'Interne Links über http:// auf einer https-Seite',
  checkPage(page) {
    if (!page.finalUrl.startsWith('https://')) return null;
    const links = (page.rendered ?? page.raw)?.links ?? [];
    const bad = links.filter((l) => l.internal && l.href.startsWith('http://'));
    return bad.length ? `${bad.length} interne http-Links, z. B. ${bad[0]!.href}` : null;
  },
};

export default plugin;
