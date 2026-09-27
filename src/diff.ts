import { effectiveFields } from './rules/fields.ts';
import { show } from './rules/engine.ts';
import type { Finding, PageResult } from './types.ts';

const TRACKED = ['status', 'redirectCount', 'title', 'metaDescription', 'canonical', 'noindex', 'h1'] as const;

export interface Change {
  url: string;
  field: string;
  before: unknown;
  after: unknown;
}

export interface RunDiff {
  added: string[];
  removed: string[];
  changes: Change[];
  newFindings: Finding[];
  resolvedFindings: Finding[];
}

const key = (f: Finding) => `${f.ruleId}\u0000${f.url}`;

export function diffRuns(before: PageResult[], after: PageResult[], fBefore: Finding[], fAfter: Finding[]): RunDiff {
  const a = new Map(before.map((p) => [p.url, p]));
  const b = new Map(after.map((p) => [p.url, p]));
  const changes: Change[] = [];
  for (const [url, pb] of b) {
    const pa = a.get(url);
    if (!pa || pa.robotsBlocked || pb.robotsBlocked) continue;
    const fa = effectiveFields(pa);
    const fb = effectiveFields(pb);
    for (const field of TRACKED) {
      if (JSON.stringify(fa[field] ?? null) !== JSON.stringify(fb[field] ?? null)) {
        changes.push({ url, field, before: fa[field] ?? null, after: fb[field] ?? null });
      }
    }
  }
  const ka = new Set(fBefore.map(key));
  const kb = new Set(fAfter.map(key));
  return {
    added: [...b.keys()].filter((u) => !a.has(u)),
    removed: [...a.keys()].filter((u) => !b.has(u)),
    changes,
    newFindings: fAfter.filter((f) => !ka.has(key(f))),
    resolvedFindings: fBefore.filter((f) => !kb.has(key(f))),
  };
}

export function formatDiff(d: RunDiff, from: number, to: number, asMarkdown = false): string {
  const lines: string[] = [];
  const cell = (s: string) => s.replace(/\|/g, '\\|');
  const head = (t: string) => lines.push(asMarkdown ? `\n### ${t}\n` : `\n${t}`);
  lines.push(
    asMarkdown ? `## Vergleich Lauf #${from} → #${to}` : `Vergleich Lauf #${from} → #${to}`,
    `${d.added.length} neue Seiten · ${d.removed.length} verschwunden · ${d.changes.length} Änderungen · ` +
      `${d.newFindings.length} neue Befunde · ${d.resolvedFindings.length} behoben`,
  );

  if (d.changes.length) {
    head('Geänderte Felder');
    if (asMarkdown) lines.push('| URL | Feld | Vorher | Nachher |', '|---|---|---|---|');
    for (const c of d.changes) {
      lines.push(
        asMarkdown
          ? `| ${cell(c.url)} | ${c.field} | ${cell(show(c.before))} | ${cell(show(c.after))} |`
          : `  ${c.url}  ${c.field}: ${show(c.before)} → ${show(c.after)}`,
      );
    }
  }
  const list = (title: string, items: string[]) => {
    if (!items.length) return;
    head(title);
    for (const i of items) lines.push(asMarkdown ? `- ${i}` : `  ${i}`);
  };
  list('Neue Seiten', d.added);
  list('Verschwundene Seiten', d.removed);
  list('Neue Befunde', d.newFindings.map((f) => `[${f.severity}] ${f.ruleId}  ${f.url}  ${f.message}`));
  list('Behobene Befunde', d.resolvedFindings.map((f) => `${f.ruleId}  ${f.url}`));
  return lines.join('\n') + '\n';
}
