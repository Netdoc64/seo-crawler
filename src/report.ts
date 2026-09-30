import { type Finding, type PageResult, SEVERITY_ORDER, type Severity } from './types.ts';

export interface RuleSummary {
  ruleId: string;
  severity: Severity;
  count: number;
  findings: Finding[];
}

export interface Summary {
  runId: number;
  name: string;
  pages: number;
  rendered: number;
  /** Extern geprüfte Link-Ziele (keine gecrawlten Seiten). */
  external: number;
  byStatus: [string, number][];
  totals: Record<Severity, number>;
  rules: RuleSummary[];
  /** Mit Strg+C abgebrochen – Seiten und Befunde sind unvollständig. */
  aborted: boolean;
}

/** Ein Satz für jede Ausgabe, damit ein abgebrochener Lauf nirgends als vollständig durchgeht. */
export const abortedNote = (s: Summary) => `Lauf abgebrochen nach ${s.pages} Seiten – Ergebnis unvollständig.`;

function statusBucket(p: PageResult): string {
  if (p.robotsBlocked) return 'robots.txt';
  if (p.status === 0) return 'Fehler';
  return `${Math.floor(p.status / 100)}xx`;
}

export function summarize(runId: number, name: string, pages: PageResult[], findings: Finding[], aborted = false): Summary {
  // Externe Link-Ziele sind keine gecrawlten Seiten – eigene Zahl, nicht in den Seitenzählern.
  const internal = pages.filter((p) => !p.external);
  const byStatus = new Map<string, number>();
  for (const p of internal) byStatus.set(statusBucket(p), (byStatus.get(statusBucket(p)) ?? 0) + 1);

  const byRule = new Map<string, RuleSummary>();
  const totals: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) {
    totals[f.severity]++;
    const r = byRule.get(f.ruleId) ?? { ruleId: f.ruleId, severity: f.severity, count: 0, findings: [] };
    r.count++;
    r.findings.push(f);
    byRule.set(f.ruleId, r);
  }
  const rules = [...byRule.values()].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.count - a.count,
  );
  return {
    runId,
    name,
    pages: internal.length,
    rendered: internal.filter((p) => p.rendered).length,
    external: pages.length - internal.length,
    byStatus: [...byStatus.entries()].sort(),
    totals,
    rules,
    aborted,
  };
}

const ICON: Record<Severity, string> = { error: '✖', warning: '▲', info: '·' };

function pad(s: string, n: number) {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

export function formatConsole(s: Summary, examples = 3): string {
  const lines: string[] = [];
  lines.push(
    `Lauf #${s.runId} „${s.name}“: ${s.pages} Seiten, davon ${s.rendered} gerendert` +
      (s.external ? ` · ${s.external} extern geprüft` : ''),
  );
  if (s.aborted) lines.push(abortedNote(s));
  lines.push(`Status:${s.byStatus.map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  lines.push(`Befunde: ${s.totals.error} Fehler · ${s.totals.warning} Warnungen · ${s.totals.info} Hinweise`);
  if (s.rules.length === 0) return lines.join('\n');
  lines.push('');
  const w = Math.max(...s.rules.map((r) => r.ruleId.length));
  for (const r of s.rules) {
    lines.push(`${ICON[r.severity]} ${pad(r.ruleId, w)}  ${String(r.count).padStart(5)}`);
    for (const f of r.findings.slice(0, examples)) lines.push(`    ${f.url}  ${f.message}`);
    if (r.count > examples) lines.push(`    … ${r.count - examples} weitere`);
  }
  return lines.join('\n');
}

const md = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function formatMarkdown(s: Summary, maxPerRule = 50): string {
  const lines: string[] = [];
  lines.push(`## SEO-Crawl „${md(s.name)}“ (Lauf #${s.runId})`);
  lines.push('');
  if (s.aborted) lines.push(`> **${abortedNote(s)}**`, '');
  lines.push(
    `${s.pages} Seiten, davon ${s.rendered} gerendert` +
      (s.external ? ` · ${s.external} extern geprüft` : '') +
      ` · Status: ${s.byStatus.map(([k, v]) => `${k} ${v}`).join(' · ')}`,
  );
  lines.push('');
  lines.push('| Schwere | Anzahl |');
  lines.push('|---|---|');
  lines.push(`| Fehler | ${s.totals.error} |`);
  lines.push(`| Warnung | ${s.totals.warning} |`);
  lines.push(`| Hinweis | ${s.totals.info} |`);
  if (s.rules.length === 0) return lines.join('\n') + '\n';
  lines.push('');
  lines.push('| Regel | Schwere | Seiten |');
  lines.push('|---|---|---|');
  for (const r of s.rules) lines.push(`| \`${r.ruleId}\` | ${r.severity} | ${r.count} |`);
  for (const r of s.rules) {
    lines.push('');
    lines.push(`<details><summary><code>${r.ruleId}</code> – ${r.count}</summary>`);
    lines.push('');
    lines.push('| URL | Befund |');
    lines.push('|---|---|');
    for (const f of r.findings.slice(0, maxPerRule)) lines.push(`| ${md(f.url)} | ${md(f.message)} |`);
    if (r.count > maxPerRule) lines.push(`| … | ${r.count - maxPerRule} weitere |`);
    lines.push('');
    lines.push('</details>');
  }
  return lines.join('\n') + '\n';
}

/** GitHub-Workflow-Befehle; erscheinen als Annotationen am Lauf. */
export function githubAnnotations(findings: Finding[], max = 50): string[] {
  const esc = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const level: Record<Severity, string> = { error: 'error', warning: 'warning', info: 'notice' };
  return [...findings]
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .slice(0, max)
    .map((f) => `::${level[f.severity]} title=${esc(f.ruleId).replace(/[,:]/g, ' ')}::${esc(`${f.url} – ${f.message}`)}`);
}

export function exceeds(findings: Finding[], failOn: Severity | 'none'): boolean {
  if (failOn === 'none') return false;
  return findings.some((f) => SEVERITY_ORDER[f.severity] <= SEVERITY_ORDER[failOn]);
}
