import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { type Config, formatIssues } from '../config.ts';
import { errMsg } from '../util.ts';
import { toRegExp } from './engine.ts';
import {
  type Check,
  type PageRule,
  PageRuleSchema,
  type Plugin,
  type RuleSet,
  type SiteRule,
  SiteRuleSchema,
} from './schema.ts';

const BUILTIN_DIR = path.join(import.meta.dirname, '..', '..', 'rules');

function resolveRef(ref: string, baseDir: string): string {
  if (ref.startsWith('builtin:')) return path.join(BUILTIN_DIR, `${ref.slice('builtin:'.length)}.yaml`);
  return path.resolve(baseDir, ref);
}

const VALUE_OPS = ['exists', 'length', 'range', 'equals', 'notEquals', 'matches', 'notMatches', 'oneOf', 'contains', 'sameHost', 'stableAcrossRender'] as const;

/** Fehler, die das Schema nicht sieht: Operator ohne Feld, kaputte Regex. */
function lintCheck(check: Check, field: string | undefined, where: string, errors: string[]): void {
  const f = check.field ?? field;
  if (!f && VALUE_OPS.some((op) => op in check)) errors.push(`${where}: Operator ohne field`);
  for (const pattern of [check.matches, check.notMatches]) {
    if (pattern === undefined) continue;
    try {
      toRegExp(pattern);
    } catch (err) {
      errors.push(`${where}: ungültige Regex ${pattern} (${errMsg(err)})`);
    }
  }
  check.all?.forEach((c, i) => lintCheck(c, f, `${where}.all[${i}]`, errors));
  check.any?.forEach((c, i) => lintCheck(c, f, `${where}.any[${i}]`, errors));
  if (check.not) lintCheck(check.not, f, `${where}.not`, errors);
}

/**
 * Lädt alle Regeldateien in Reihenfolge. Gleiche id in einer späteren Datei ersetzt die frühere –
 * so lassen sich Grundregeln projektweise überschreiben. Danach greifen `ruleOverrides`.
 */
export async function loadRules(config: Config): Promise<RuleSet> {
  const byId = new Map<string, PageRule | SiteRule>();
  const errors: string[] = [];

  for (const ref of config.rules) {
    const file = resolveRef(ref, config.baseDir);
    let doc: { rules?: unknown };
    try {
      doc = (parseYaml(await readFile(file, 'utf8')) as { rules?: unknown } | null) ?? {};
    } catch (err) {
      errors.push(`${ref}: ${errMsg(err)}`);
      continue;
    }
    if (!Array.isArray(doc.rules)) {
      errors.push(`${ref}: erwartet eine Liste unter „rules:“`);
      continue;
    }
    doc.rules.forEach((raw: unknown, i: number) => {
      const id = (raw as { id?: unknown })?.id ?? `#${i}`;
      const where = `${ref} › ${String(id)}`;
      const isSite = (raw as { scope?: unknown })?.scope === 'site';
      const parsed = isSite ? SiteRuleSchema.safeParse(raw) : PageRuleSchema.safeParse(raw);
      if (!parsed.success) {
        errors.push(`${where}:\n${formatIssues(parsed.error.issues)}`);
        return;
      }
      const rule = parsed.data;
      if (rule.scope === 'page') {
        lintCheck(rule.check, undefined, `${where} check`, errors);
        if (rule.when) lintCheck(rule.when, undefined, `${where} when`, errors);
      }
      byId.set(rule.id, rule);
    });
  }

  for (const [id, override] of Object.entries(config.ruleOverrides)) {
    const rule = byId.get(id);
    if (!rule) {
      errors.push(`ruleOverrides: keine Regel mit id „${id}“`);
      continue;
    }
    byId.set(id, { ...rule, ...override } as PageRule | SiteRule);
  }

  const plugins: Plugin[] = [];
  for (const ref of config.plugins) {
    try {
      const mod = (await import(pathToFileURL(path.resolve(config.baseDir, ref)).href)) as { default?: Plugin | Plugin[] };
      const list = Array.isArray(mod.default) ? mod.default : mod.default ? [mod.default] : [];
      if (list.length === 0) errors.push(`Plugin ${ref}: kein default-Export`);
      for (const p of list) {
        if (!p.id || (!p.checkPage && !p.checkSite)) errors.push(`Plugin ${ref}: braucht id und checkPage oder checkSite`);
        else plugins.push(p);
      }
    } catch (err) {
      errors.push(`Plugin ${ref}: ${errMsg(err)}`);
    }
  }

  if (errors.length) throw new Error(`Regeln ungültig:\n${errors.map((e) => `- ${e}`).join('\n')}`);

  const active = [...byId.values()].filter((r) => r.enabled);
  return {
    page: active.filter((r): r is PageRule => r.scope === 'page'),
    site: active.filter((r): r is SiteRule => r.scope === 'site'),
    plugins,
  };
}
