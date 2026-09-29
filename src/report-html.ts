import type { PageResult, Severity } from './types.ts';
import { abortedNote, type Summary } from './report.ts';

export interface HtmlReportData {
  summary: Summary;
  pages: PageResult[];
  /** Regel-id → Beschreibung; darf fehlen (z. B. bei report aus der DB). */
  descriptions?: Record<string, string>;
  generatedAt: string;
}

const SEVERITY_LABEL: Record<Severity, string> = { error: 'Fehler', warning: 'Warnung', info: 'Hinweis' };

/** HTML-Kontext: alles aus fremden Seiten wird escaped. */
export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** JSON sicher in ein <script>-Tag einbetten: `<` darf darin nicht vorkommen (</script>-Schutz). */
function jsonInline(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

const CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { font-family: system-ui, sans-serif; margin: 0; padding: 1.5rem; max-width: 75rem; }
h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
th, td { border: 1px solid; padding: 0.3rem 0.5rem; text-align: left; vertical-align: top; }
th { cursor: pointer; user-select: none; }
td.url, td.msg { word-break: break-all; }
.cards { display: flex; gap: 1rem; flex-wrap: wrap; margin: 1rem 0; }
.card { border: 1px solid; border-radius: 0.5rem; padding: 0.6rem 1rem; }
.card b { font-size: 1.3rem; display: block; }
.sev-error { border-left: 0.4rem solid #c00; }
.sev-warning { border-left: 0.4rem solid #c80; }
.sev-info { border-left: 0.4rem solid #36c; }
fieldset { border: 1px solid; border-radius: 0.5rem; display: inline-block; margin-right: 1rem; }
input[type=search] { padding: 0.3rem; min-width: 16rem; }
tr.hidden { display: none; }
details { margin: 0.4rem 0; }
.empty { padding: 2rem; text-align: center; border: 1px dashed; border-radius: 0.5rem; }
.abbruch { padding: 0.5rem 0.75rem; border-left: 4px solid #d97706; }
`;

// Filter und Sortierung laufen komplett im Browser; ohne JS bleibt alles sichtbar.
const JS = `
const DATA = JSON.parse(document.getElementById('daten').textContent);
const rows = document.querySelectorAll('#befunde tbody tr');
const pagesRows = document.querySelectorAll('#seiten tbody tr');
const sevBoxes = document.querySelectorAll('input[name=sev]');
const ruleSel = document.getElementById('regel');
const search = document.getElementById('suche');
const count = document.getElementById('anzahl');
const PAGE = 500;
let shown = 0;

function apply() {
  const sevs = new Set([...sevBoxes].filter(b => b.checked).map(b => b.value));
  const rule = ruleSel.value;
  const q = search.value.toLowerCase();
  shown = 0;
  for (const tr of rows) {
    const ok = sevs.has(tr.dataset.sev) && (!rule || tr.dataset.rule === rule) &&
      (!q || tr.textContent.toLowerCase().includes(q));
    const visible = ok && shown < PAGE;
    if (ok) shown++;
    tr.classList.toggle('hidden', !visible);
  }
  count.textContent = shown > PAGE ? shown + ' Treffer, erste ' + PAGE + ' gezeigt' : shown + ' Treffer';
}
for (const el of [...sevBoxes, ruleSel, search]) el.addEventListener('input', apply);
apply();

for (const th of document.querySelectorAll('th[data-sort]')) {
  th.addEventListener('click', () => {
    const table = th.closest('table');
    const idx = [...th.parentNode.children].indexOf(th);
    const num = th.dataset.sort === 'num';
    const dir = th.dataset.dir === 'asc' ? -1 : 1;
    th.dataset.dir = th.dataset.dir === 'asc' ? 'desc' : 'asc';
    [...table.tBodies[0].rows]
      .sort((a, b) => {
        const x = a.cells[idx].textContent, y = b.cells[idx].textContent;
        return (num ? Number(x) - Number(y) : x.localeCompare(y)) * dir;
      })
      .forEach(tr => table.tBodies[0].appendChild(tr));
  });
}
`;

function findingRows(s: Summary): string {
  const rows: string[] = [];
  for (const r of s.rules) {
    for (const f of r.findings) {
      rows.push(
        `<tr data-sev="${f.severity}" data-rule="${esc(f.ruleId)}">` +
          `<td>${SEVERITY_LABEL[f.severity]}</td><td>${esc(f.ruleId)}</td>` +
          `<td class="url">${esc(f.url)}</td><td class="msg">${esc(f.message)}</td></tr>`,
      );
    }
  }
  return rows.join('\n');
}

function pageRows(data: HtmlReportData): string {
  const perPage = new Map<string, number>();
  for (const r of data.summary.rules) for (const f of r.findings) perPage.set(f.url, (perPage.get(f.url) ?? 0) + 1);
  return data.pages
    .map((p) => {
      const title = (p.rendered ?? p.raw)?.title ?? '';
      return (
        `<tr><td class="url">${esc(p.url)}</td><td>${p.status || esc(p.error ?? '')}</td><td>${p.depth}</td>` +
        `<td>${esc(title)}</td><td>${p.rendered ? 'ja' : 'nein'}</td><td>${perPage.get(p.url) ?? 0}</td></tr>`
      );
    })
    .join('\n');
}

/** Eine eigenständige HTML-Datei ohne externe Ressourcen – funktioniert offline. */
export function formatHtml(data: HtmlReportData): string {
  const s = data.summary;
  const ruleOptions = s.rules.map((r) => `<option value="${esc(r.ruleId)}">${esc(r.ruleId)} (${r.count})</option>`).join('');
  const ruleTable = s.rules
    .map((r) => {
      const desc = data.descriptions?.[r.ruleId];
      return `<tr><td>${esc(r.ruleId)}</td><td>${SEVERITY_LABEL[r.severity]}</td><td>${r.count}</td><td>${esc(desc ?? '')}</td></tr>`;
    })
    .join('\n');
  const findingsBody =
    s.rules.length === 0
      ? '<p class="empty">Keine Befunde in diesem Lauf.</p>'
      : `<fieldset><legend>Schwere</legend>${(['error', 'warning', 'info'] as const)
          .map(
            (sev) =>
              `<label><input type="checkbox" name="sev" value="${sev}" checked> ${SEVERITY_LABEL[sev]} (${s.totals[sev]})</label> `,
          )
          .join('')}</fieldset>
<label>Regel <select id="regel"><option value="">alle</option>${ruleOptions}</select></label>
<input type="search" id="suche" placeholder="URL oder Text suchen …">
<p id="anzahl"></p>
<table id="befunde"><thead><tr><th>Schwere</th><th>Regel</th><th>URL</th><th>Befund</th></tr></thead>
<tbody>
${findingRows(s)}
</tbody></table>`;

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SEO-Bericht – ${esc(s.name)} (Lauf #${s.runId})</title>
<style>${CSS}</style>
</head>
<body>
<h1>SEO-Bericht „${esc(s.name)}“ <small>Lauf #${s.runId}</small></h1>
${s.aborted ? `<p class="abbruch"><strong>${esc(abortedNote(s))}</strong></p>\n` : ''}<p>Erstellt ${esc(data.generatedAt)} · ${s.pages} Seiten, davon ${s.rendered} gerendert ·
Status: ${s.byStatus.map(([k, v]) => `${esc(k)} ${v}`).join(' · ')}</p>
<div class="cards">
<div class="card sev-error"><b>${s.totals.error}</b>Fehler</div>
<div class="card sev-warning"><b>${s.totals.warning}</b>Warnungen</div>
<div class="card sev-info"><b>${s.totals.info}</b>Hinweise</div>
</div>
<h2>Regeln</h2>
<table><thead><tr><th>Regel</th><th>Schwere</th><th>Anzahl</th><th>Beschreibung</th></tr></thead>
<tbody>
${ruleTable}
</tbody></table>
<h2>Befunde</h2>
${findingsBody}
<h2>Seiten</h2>
<table id="seiten"><thead><tr>
<th data-sort>URL</th><th data-sort="num">Status</th><th data-sort="num">Tiefe</th><th data-sort>Title</th>
<th data-sort>gerendert</th><th data-sort="num">Befunde</th></tr></thead>
<tbody>
${pageRows(data)}
</tbody></table>
<script type="application/json" id="daten">${jsonInline({ runId: s.runId, name: s.name })}</script>
<script>${JS}</script>
</body>
</html>
`;
}
