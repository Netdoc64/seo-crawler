import { appendFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { crawl } from './crawler/crawler.ts';
import { diffRuns, formatDiff } from './diff.ts';
import { exceeds, formatConsole, formatMarkdown, githubAnnotations, summarize } from './report.ts';
import { runRules } from './rules/engine.ts';
import { loadRules } from './rules/load.ts';
import { Store } from './store/db.ts';
import type { Severity } from './types.ts';

const DEFAULT_DB = 'runs/seo-crawler.sqlite';

const HELP = `seo-crawler – SEO-Crawler mit JS-Rendering und Regel-Engine

Befehle
  crawl [url …]            Crawlen, Regeln prüfen, Lauf speichern
    -c, --config <datei>   YAML-Konfiguration
    --mode raw|render|auto Rendern: nie | immer | nur bei JS-Apps (Standard: auto)
    --max-pages <n>        Obergrenze für gefundene Seiten
    --max-depth <n>        Klicktiefe ab Start-URL
    --no-follow            nur die angegebenen URLs, keinen Links folgen (Bulk-Modus)
    --url-file <datei>     eine URL pro Zeile
    --sitemap <url>        Sitemap als Startliste (mehrfach möglich)
    --md <datei>           Bericht als Markdown
    --json <datei>         Befunde und Zusammenfassung als JSON
    --fail-on error|warning|info|none   Exitcode 1 ab dieser Schwere (Standard: none)
    -q, --quiet            keine Fortschrittszeilen
  rules [-c <datei>]       aktive Regeln anzeigen (prüft die Regeldateien)
  runs                     gespeicherte Läufe auflisten
  report [lauf]            Bericht eines Laufs (Standard: letzter)
  diff [von] [bis]         zwei Läufe vergleichen (Standard: die letzten zwei gleichen Namens)

Gemeinsam
  --db <datei>             SQLite-Datei (Standard: ${DEFAULT_DB})
`;

const FAIL_LEVELS = ['error', 'warning', 'info', 'none'] as const;

function int(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name}: ganze Zahl erwartet, bekam „${v}“`);
  return n;
}

async function writeOutputs(
  md: string | undefined,
  json: string | undefined,
  markdown: string,
  data: unknown,
): Promise<void> {
  if (md) await writeFile(md, markdown);
  if (json) await writeFile(json, JSON.stringify(data, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
}

async function cmdCrawl(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      mode: { type: 'string' },
      'max-pages': { type: 'string' },
      'max-depth': { type: 'string' },
      'no-follow': { type: 'boolean' },
      'url-file': { type: 'string' },
      sitemap: { type: 'string', multiple: true },
      db: { type: 'string' },
      md: { type: 'string' },
      json: { type: 'string' },
      'fail-on': { type: 'string', default: 'none' },
      quiet: { type: 'boolean', short: 'q' },
    },
  });
  const failOn = values['fail-on'] as (typeof FAIL_LEVELS)[number];
  if (!FAIL_LEVELS.includes(failOn)) throw new Error(`--fail-on: erwartet ${FAIL_LEVELS.join('|')}`);

  const config = await loadConfig(values.config, {
    urls: positionals,
    sitemaps: values.sitemap,
    urlFile: values['url-file'],
    mode: values.mode,
    maxPages: int(values['max-pages'], '--max-pages'),
    maxDepth: int(values['max-depth'], '--max-depth'),
    noFollow: values['no-follow'],
    db: values.db,
  });
  // Regeln zuerst laden: ein Tippfehler in einer Regel soll nicht erst nach dem Crawl auffallen.
  const rules = await loadRules(config);

  const store = new Store(config.output.db);
  try {
    const { baseDir: _baseDir, ...storedConfig } = config;
    const runId = store.startRun(config.name, storedConfig);
    const pages = await crawl(config, {
      onPage(p, { done, queued }) {
        store.savePage(runId, p);
        if (values.quiet) return;
        const status = p.robotsBlocked ? 'robots' : p.status === 0 ? 'FEHLER' : String(p.status);
        const tags = [p.redirects.length ? `→ ${p.finalUrl}` : '', p.rendered ? '[gerendert]' : '', p.duplicateOf ? '[Ziel bekannt]' : '']
          .filter(Boolean)
          .join(' ');
        console.error(`[${done}/${done + queued}] ${status.padEnd(6)} ${p.url} ${tags}`);
      },
      onWarn: (m) => console.error(`Warnung: ${m}`),
    });

    const findings = runRules(pages, rules);
    store.finishRun(runId, pages.length, findings);

    const summary = summarize(runId, config.name, pages, findings);
    console.log(`\n${formatConsole(summary)}`);
    await writeOutputs(values.md, values.json, formatMarkdown(summary), { summary: { ...summary, rules: undefined }, findings });
    if (process.env.GITHUB_ACTIONS === 'true') for (const line of githubAnnotations(findings)) console.log(line);
    console.error(`\nGespeichert als Lauf #${runId} in ${config.output.db}`);
    return exceeds(findings, failOn) ? 1 : 0;
  } finally {
    store.close();
  }
}

async function cmdRules(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { config: { type: 'string', short: 'c' } } });
  const rules = await loadRules(await loadConfig(values.config));
  const rows = [
    ...rules.page.map((r) => [r.id, 'Seite', r.severity, r.description ?? '']),
    ...rules.site.map((r) => [r.id, 'Website', r.severity, r.description ?? '']),
    ...rules.plugins.map((p) => [p.id, 'Plugin', p.severity ?? 'warning', p.description ?? '']),
  ];
  const w = Math.max(...rows.map((r) => r[0]!.length));
  for (const [id, scope, sev, desc] of rows) console.log(`${id!.padEnd(w)}  ${scope!.padEnd(7)}  ${sev!.padEnd(7)}  ${desc}`);
  console.log(`\n${rows.length} Regeln aktiv`);
  return 0;
}

function openStore(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { db: { type: 'string' }, md: { type: 'string' }, json: { type: 'string' } },
  });
  return { store: new Store(values.db ?? DEFAULT_DB), values, positionals };
}

async function cmdRuns(args: string[]): Promise<number> {
  const { store } = openStore(args);
  try {
    const runs = store.listRuns();
    if (runs.length === 0) console.log('Noch keine Läufe.');
    for (const r of runs) {
      console.log(
        `#${String(r.id).padEnd(4)} ${r.startedAt.replace('T', ' ').slice(0, 19)}  ${r.name.padEnd(20)} ` +
          (r.finishedAt ? `${r.pages} Seiten, ${r.findings} Befunde` : 'abgebrochen'),
      );
    }
    return 0;
  } finally {
    store.close();
  }
}

async function cmdReport(args: string[]): Promise<number> {
  const { store, values, positionals } = openStore(args);
  try {
    const run = positionals[0] ? store.getRun(Number(positionals[0])) : (store.listRuns()[0] ?? null);
    if (!run) throw new Error('Lauf nicht gefunden.');
    const findings = store.loadFindings(run.id);
    const summary = summarize(run.id, run.name, store.loadPages(run.id), findings);
    console.log(formatConsole(summary, 10));
    await writeOutputs(values.md, values.json, formatMarkdown(summary), { summary: { ...summary, rules: undefined }, findings });
    return 0;
  } finally {
    store.close();
  }
}

async function cmdDiff(args: string[]): Promise<number> {
  const { store, values, positionals } = openStore(args);
  try {
    let from: number;
    let to: number;
    if (positionals.length >= 2) {
      from = Number(positionals[0]);
      to = Number(positionals[1]);
    } else {
      const latest = store.listRuns().find((r) => r.finishedAt);
      const pair = latest ? store.listRuns(latest.name).filter((r) => r.finishedAt) : [];
      if (pair.length < 2) throw new Error('Für den Vergleich braucht es zwei abgeschlossene Läufe mit gleichem Namen – oder zwei Lauf-Nummern.');
      to = pair[0]!.id;
      from = pair[1]!.id;
    }
    for (const id of [from, to]) if (!store.getRun(id)) throw new Error(`Lauf #${id} nicht gefunden.`);
    const d = diffRuns(store.loadPages(from), store.loadPages(to), store.loadFindings(from), store.loadFindings(to));
    console.log(formatDiff(d, from, to));
    const md = formatDiff(d, from, to, true);
    if (values.md) await writeFile(values.md, md);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md);
    return 0;
  } finally {
    store.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'crawl':
      return cmdCrawl(rest);
    case 'rules':
      return cmdRules(rest);
    case 'runs':
      return cmdRuns(rest);
    case 'report':
      return cmdReport(rest);
    case 'diff':
      return cmdDiff(rest);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;
    default:
      console.error(`Unbekannter Befehl „${cmd}“.\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 2;
  },
);
