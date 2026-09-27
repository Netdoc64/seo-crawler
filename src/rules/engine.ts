import type { Finding, PageResult } from '../types.ts';
import { globToRegExp, isHtml, normalizeUrl, siteKey } from '../url.ts';
import { errMsg } from '../util.ts';
import { effectiveFields, getPath, pageFields } from './fields.ts';
import type { Applies, Check, Fields, Range, RuleSet, SiteRule } from './schema.ts';

export interface EvalContext {
  fields: Fields;
  raw: Fields | null;
  rendered: Fields | null;
  /** siteKey der Seite, für sameHost. */
  pageHost: string;
}

const regexCache = new Map<string, RegExp>();

/** "muster" (Groß/Klein egal) oder "/muster/flags" (Flags genau so). */
export function toRegExp(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (!re) {
    const m = /^\/(.*)\/([dgimsuvy]*)$/s.exec(pattern);
    re = m ? new RegExp(m[1]!, m[2]) : new RegExp(pattern, 'i');
    regexCache.set(pattern, re);
  }
  return re;
}

const present = (v: unknown) =>
  v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0);

const lengthOf = (v: unknown) => (typeof v === 'string' || Array.isArray(v) ? v.length : 0);

const inRange = (n: number, r: Range) => (r.min === undefined || n >= r.min) && (r.max === undefined || n <= r.max);

const showRange = (r: Range) =>
  r.min !== undefined && r.max !== undefined ? `${r.min}–${r.max}` : r.min !== undefined ? `≥ ${r.min}` : `≤ ${r.max}`;

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function show(v: unknown): string {
  const s = typeof v === 'string' ? `„${v}“` : JSON.stringify(v ?? null);
  return s.length > 90 ? `${s.slice(0, 87)}…` : s;
}

const asStrings = (v: unknown): string[] =>
  v === null || v === undefined
    ? []
    : (Array.isArray(v) ? v : [v]).map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));

/** Liefert die Verstöße; leer heißt bestanden. Unterprüfungen erben `field` von oben. */
export function evalCheck(check: Check, ctx: EvalContext, inherited?: string): string[] {
  const field = check.field ?? inherited;
  const fails: string[] = [];

  if (check.all) for (const c of check.all) fails.push(...evalCheck(c, ctx, field));
  if (check.any) {
    const results = check.any.map((c) => evalCheck(c, ctx, field));
    if (!results.some((r) => r.length === 0)) fails.push(`keine Alternative erfüllt: ${results.map((r) => r.join(', ')).join(' | ')}`);
  }
  if (check.not && evalCheck(check.not, ctx, field).length === 0) {
    fails.push(`${field ?? 'Bedingung'}: trifft zu, sollte aber nicht`);
  }
  if (field === undefined) return fails;

  const value = getPath(ctx.fields, field);
  if (check.exists !== undefined && present(value) !== check.exists) {
    fails.push(check.exists ? `${field} fehlt` : `${field} sollte fehlen, ist ${show(value)}`);
  }
  if (check.length) {
    const len = lengthOf(value);
    if (!inRange(len, check.length)) fails.push(`${field}: Länge ${len}, erlaubt ${showRange(check.length)}`);
  }
  if (check.range) {
    if (typeof value !== 'number') fails.push(`${field}: kein Zahlenwert`);
    else if (!inRange(value, check.range)) fails.push(`${field}: ${value}, erlaubt ${showRange(check.range)}`);
  }
  if ('equals' in check && !same(value, check.equals)) fails.push(`${field}: ${show(value)}, erwartet ${show(check.equals)}`);
  if ('notEquals' in check && same(value, check.notEquals)) fails.push(`${field}: darf nicht ${show(check.notEquals)} sein`);
  if (check.matches !== undefined) {
    const re = toRegExp(check.matches);
    if (!asStrings(value).some((v) => re.test(v))) fails.push(`${field}: ${show(value)} passt nicht auf ${check.matches}`);
  }
  if (check.notMatches !== undefined) {
    const re = toRegExp(check.notMatches);
    const hit = asStrings(value).find((v) => re.test(v));
    if (hit !== undefined) fails.push(`${field}: ${show(hit)} passt auf ${check.notMatches}`);
  }
  if (check.oneOf && !check.oneOf.some((o) => same(o, value))) {
    fails.push(`${field}: ${show(value)} nicht in ${show(check.oneOf)}`);
  }
  if (check.contains !== undefined) {
    const ok = Array.isArray(value)
      ? asStrings(value).includes(check.contains)
      : typeof value === 'string' && value.includes(check.contains);
    if (!ok) fails.push(`${field} enthält ${show(check.contains)} nicht`);
  }
  if (check.sameHost && typeof value === 'string' && value) {
    try {
      if (siteKey(new URL(value).hostname) !== ctx.pageHost) fails.push(`${field} zeigt auf fremden Host: ${value}`);
    } catch {
      fails.push(`${field}: keine gültige URL`);
    }
  }
  if (check.stableAcrossRender && ctx.raw && ctx.rendered) {
    const before = getPath(ctx.raw, field);
    const after = getPath(ctx.rendered, field);
    if (!same(before, after)) fails.push(`${field} ändert sich durch JavaScript: roh ${show(before)} → gerendert ${show(after)}`);
  }
  return fails;
}

function appliesTo(a: Applies | undefined, p: PageResult, fields: Fields): boolean {
  if (p.robotsBlocked) return false;
  const html = a?.html ?? true;
  if (html && !(p.rendered ?? p.raw)) return false;
  if (html && !isHtml(p.contentType)) return false;
  if (!inRange(p.status, a?.status ?? { min: 200, max: 299 })) return false;
  const path = String(fields.path);
  if (a?.path && !a.path.some((g) => globToRegExp(g).test(path))) return false;
  if (a?.exclude?.some((g) => globToRegExp(g).test(path))) return false;
  if (a?.indexable !== undefined && fields.indexable !== a.indexable) return false;
  return true;
}

function fill(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    if (!(key in vars)) return whole;
    const v = vars[key];
    return typeof v === 'string' ? v : JSON.stringify(v ?? null);
  });
}

function runSiteRule(rule: SiteRule, pages: PageResult[]): Finding[] {
  const out: Finding[] = [];
  const add = (url: string, detail: string) =>
    out.push({
      ruleId: rule.id,
      severity: rule.severity,
      url,
      message: rule.message ? fill(rule.message, { url, detail }) : detail,
    });
  const sources = pages.map((p) => ({ p, f: effectiveFields(p) })).filter(({ p, f }) => appliesTo(rule.applies, p, f));
  const check = rule.check;

  if ('unique' in check) {
    const groups = new Map<string, string[]>();
    for (const { p, f } of sources) {
      const v = getPath(f, check.unique);
      if (!present(v)) continue;
      const key = Array.isArray(v) ? v.join('\n') : String(v);
      groups.set(key, [...(groups.get(key) ?? []), p.url]);
    }
    for (const [value, urls] of groups) {
      if (urls.length < 2) continue;
      for (const url of urls) {
        const others = urls.filter((u) => u !== url);
        const list = others.slice(0, 3).join(', ') + (others.length > 3 ? ` (+${others.length - 3})` : '');
        add(url, `${check.unique} ${show(value)} auch auf ${list}`);
      }
    }
    return out;
  }

  // Jede gecrawlte Adresse – auch Zwischenstufen einer Weiterleitung – zeigt auf ihr Ergebnis.
  const byUrl = new Map<string, PageResult>();
  for (const p of pages) {
    byUrl.set(p.finalUrl, p);
    for (const hop of p.redirects) byUrl.set(hop.url, p);
  }
  for (const p of pages) byUrl.set(p.url, p);

  if ('canonicalTarget' in check) {
    for (const { p } of sources) {
      const canonical = (p.rendered ?? p.raw)?.canonical;
      if (!canonical) continue;
      const target = normalizeUrl(canonical);
      // Selbstverweis (auch mit anderem Slash/Query) und fremde Domains sind hier nicht gemeint –
      // letztere meldet schon die Seitenregel `canonical`.
      if (!target || target === normalizeUrl(p.finalUrl)) continue;
      if (siteKey(new URL(target).hostname) !== siteKey(new URL(p.finalUrl).hostname)) continue;
      const hit = byUrl.get(target);
      if (!hit || hit === p || hit.robotsBlocked) continue; // Ziel unbekannt = nicht falsch
      if (hit.status < 200 || hit.status >= 300) {
        add(p.url, `Canonical zeigt auf ${target} (${hit.status || hit.error})`);
      } else if (hit.redirects.length > 0 && target !== normalizeUrl(hit.finalUrl)) {
        add(p.url, `Canonical zeigt auf Weiterleitung nach ${hit.finalUrl}`);
      } else if (effectiveFields(hit).noindex) {
        add(p.url, `Canonical zeigt auf noindex-Seite ${target}`);
      } else {
        // Nur einen Schritt weiterschauen – Schleifen (a → b → a) werden so einmal gemeldet.
        const next = (hit.rendered ?? hit.raw)?.canonical;
        const nextUrl = next ? normalizeUrl(next) : null;
        if (nextUrl && nextUrl !== normalizeUrl(hit.finalUrl)) {
          add(p.url, `Canonical-Kette: ${p.url} → ${target} → ${nextUrl}`);
        }
      }
    }
    return out;
  }

  for (const { p } of sources) {
    const seen = new Set<string>();
    for (const link of (p.rendered ?? p.raw)?.links ?? []) {
      if (!link.internal || seen.has(link.href)) continue;
      seen.add(link.href);
      const target = byUrl.get(link.href);
      if (!target || target.robotsBlocked) continue;
      if ('brokenLinks' in check && (target.status === 0 || target.status >= 400)) {
        add(p.url, `Link auf ${link.href} → ${target.status || target.error}`);
      }
      if ('redirectingLinks' in check && target.redirects.length > 0 && link.href !== target.finalUrl) {
        add(p.url, `Link auf ${link.href} leitet weiter nach ${target.finalUrl}`);
      }
    }
  }
  return out;
}

export function runRules(pages: PageResult[], rules: RuleSet): Finding[] {
  const findings: Finding[] = [];

  for (const p of pages) {
    const raw = p.raw ? pageFields(p, p.raw) : null;
    const rendered = p.rendered ? pageFields(p, p.rendered) : null;
    const effective = rendered ?? raw ?? pageFields(p, null);
    const pageHost = siteKey(new URL(p.finalUrl).hostname);

    for (const rule of rules.page) {
      const fields = rule.source === 'raw' ? raw : rule.source === 'rendered' ? rendered : effective;
      if (!fields || !appliesTo(rule.applies, p, fields)) continue;
      const ctx: EvalContext = { fields, raw, rendered, pageHost };
      if (rule.when && evalCheck(rule.when, ctx).length > 0) continue;
      const fails = evalCheck(rule.check, ctx);
      if (fails.length === 0) continue;
      const value = rule.check.field ? getPath(fields, rule.check.field) : undefined;
      findings.push({
        ruleId: rule.id,
        severity: rule.severity,
        url: p.url,
        message: rule.message
          ? fill(rule.message, { value, field: rule.check.field, url: p.url, detail: fails.join('; ') })
          : fails.join('; '),
      });
    }

    for (const plugin of rules.plugins) {
      if (!plugin.checkPage || p.robotsBlocked) continue;
      try {
        const result = plugin.checkPage(p, effective);
        for (const message of result ? (Array.isArray(result) ? result : [result]) : []) {
          findings.push({ ruleId: plugin.id, severity: plugin.severity ?? 'warning', url: p.url, message });
        }
      } catch (err) {
        findings.push({ ruleId: plugin.id, severity: 'error', url: p.url, message: `Plugin-Fehler: ${errMsg(err)}` });
      }
    }
  }

  for (const rule of rules.site) findings.push(...runSiteRule(rule, pages));
  for (const plugin of rules.plugins) {
    if (!plugin.checkSite) continue;
    try {
      for (const { url, message } of plugin.checkSite(pages)) {
        findings.push({ ruleId: plugin.id, severity: plugin.severity ?? 'warning', url, message });
      }
    } catch (err) {
      findings.push({ ruleId: plugin.id, severity: 'error', url: '', message: `Plugin-Fehler: ${errMsg(err)}` });
    }
  }
  return findings;
}
