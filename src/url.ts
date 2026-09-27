const TRACKING_PARAM = /^(utm_.+|fbclid|gclid|msclkid|mc_cid|mc_eid)$/i;

/** Absolute, vergleichbare URL oder null, wenn es kein http(s)-Ziel ist. */
export function normalizeUrl(input: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim(), base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
  }
  return u.toString();
}

/** Host ohne führendes www. – www und nackte Domain gelten als dieselbe Seite. */
export function siteKey(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

/** Pfad-Glob: `*` innerhalb eines Segments, `**` über Segmente, `?` ein Zeichen. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function isHtml(contentType: string | null): boolean {
  return contentType !== null && /text\/html|application\/xhtml\+xml/i.test(contentType);
}
