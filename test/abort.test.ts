import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { parseConfig } from '../src/config.ts';
import { crawl } from '../src/crawler/crawler.ts';
import { diffRuns, formatDiff } from '../src/diff.ts';
import { formatConsole, formatMarkdown, summarize } from '../src/report.ts';
import { formatHtml } from '../src/report-html.ts';
import { Store } from '../src/store/db.ts';
import { page, startFixture } from './fixture.ts';

const SLOW_PATHS = [1, 2, 3, 4, 5, 6].map((i) => `/langsam-${i}`);
const SLOW = Object.fromEntries(SLOW_PATHS.map((p) => [p, { delayMs: 2000, body: page({ title: `Langsam ${p}`, h1: ['L'] }) }]));

function config(raw: Record<string, any>) {
  return parseConfig({ render: { mode: 'raw' }, ...raw, politeness: { delayMs: 0, ...raw.politeness } }, process.cwd());
}

const pathOf = (url: string) => new URL(url).pathname;

test('Abbruch nach 200 ms: fertige Seiten kommen zurück, laufende Abrufe enden, Aufruf < 3 s', async (t) => {
  const fx = await startFixture(SLOW);
  t.after(() => fx.close());
  const c = config({
    start: { urls: [`${fx.origin}/a`, ...SLOW_PATHS.map((p) => fx.origin + p)] },
    scope: { followLinks: false },
    politeness: { concurrency: 2, perHost: 2 },
  });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const started = Date.now();
  const warnings: string[] = [];
  const pages = await crawl(c, { signal: ac.signal, onWarn: (m) => warnings.push(m) });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 3000, `dauerte ${elapsed} ms`);
  // Zwei Worker: /a und /langsam-1 sofort, nach /a noch /langsam-2 – danach darf nichts mehr starten.
  assert.deepEqual(pages.map((p) => pathOf(p.url)).sort(), ['/a', '/langsam-1', '/langsam-2']);
  assert.ok(pages.every((p) => p.status === 200), 'laufende Abrufe wurden zu Ende geführt');
  assert.ok(!fx.hits.some((h) => /langsam-[3-6]/.test(h)), 'nach dem Abbruch kein neuer Abruf');
  assert.deepEqual(warnings, []);
});

test('Abbruch während Crawl-delay wartet nicht minutenlang', async (t) => {
  const fx = await startFixture({ '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nCrawl-delay: 60\n' } });
  t.after(() => fx.close());
  const c = config({
    start: { urls: [`${fx.origin}/a`, `${fx.origin}/b`] },
    scope: { followLinks: false },
    politeness: { concurrency: 2, perHost: 2 },
  });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const started = Date.now();
  const warnings: string[] = [];
  const pages = await crawl(c, { signal: ac.signal, onWarn: (m) => warnings.push(m) });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 3000, `dauerte ${elapsed} ms`);
  assert.equal(pages.length, 1, 'nur der erste Abruf lief, der zweite hing im Crawl-delay');
  assert.equal(fx.hits.filter((h) => h === 'GET /a' || h === 'GET /b').length, 1);
  assert.deepEqual(warnings, []);
});

test('Abbruch vor der ersten Seite: 0 Seiten, kein Fehler, kein Abruf', async (t) => {
  const fx = await startFixture();
  t.after(() => fx.close());
  const ac = new AbortController();
  ac.abort();
  const pages = await crawl(config({ start: { urls: [`${fx.origin}/`] } }), { signal: ac.signal });
  assert.deepEqual(pages, []);
  assert.deepEqual(fx.hits, []);
});

test('Abbruch während die Sitemap lädt: 0 Seiten, keine Warnung, schnell', async (t) => {
  const fx = await startFixture({
    '/langsam-sitemap.xml': {
      type: 'application/xml',
      delayMs: 2000,
      body: '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>__ORIGIN__/a</loc></url></urlset>',
    },
  });
  t.after(() => fx.close());
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const warnings: string[] = [];
  const started = Date.now();
  const pages = await crawl(config({ start: { sitemaps: [`${fx.origin}/langsam-sitemap.xml`] } }), {
    signal: ac.signal,
    onWarn: (m) => warnings.push(m),
  });
  assert.ok(Date.now() - started < 1500);
  assert.deepEqual(pages, []);
  assert.deepEqual(warnings, []);
});

test('Abbruch, während Chromium noch startet', async (t) => {
  try {
    await (await chromium.launch()).close();
  } catch {
    t.skip('Chromium nicht installiert – npm run setup');
    return;
  }
  const fx = await startFixture();
  t.after(() => fx.close());
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);
  const pages = await crawl(config({ start: { urls: [`${fx.origin}/`] }, render: { mode: 'render' } }), { signal: ac.signal });
  assert.deepEqual(pages, []);
  assert.ok(!fx.hits.includes('GET /'), 'nach dem Abbruch keine Seite mehr abgerufen');
});

test('Abbruch während der Externprüfung: laufende Prüfung endet, wartende fallen weg', async (t) => {
  const paths = ['/e1', '/e2', '/e3', '/e4'];
  const foreign = await startFixture(Object.fromEntries(paths.map((p) => [p, { delayMs: 2000, body: page({ title: p, h1: [p] }) }])));
  t.after(() => foreign.close());
  // Fremder Host über localhost, damit er nicht zum Scope gehört (siehe external.test.ts).
  const targets = paths.map((p) => foreign.origin.replace('127.0.0.1', 'localhost') + p);
  const fx = await startFixture({ '/ext-langsam': { body: page({ title: 'Externe Ziele', h1: ['x'], links: targets }) } });
  t.after(() => fx.close());

  const ac = new AbortController();
  const warnings: string[] = [];
  const started = Date.now();
  const pages = await crawl(
    config({
      start: { urls: [`${fx.origin}/ext-langsam`] },
      scope: { followLinks: false, checkExternal: true },
      politeness: { perHost: 1 },
    }),
    {
      signal: ac.signal,
      // Die einzige Seite ist fertig – der Abbruch trifft die Externprüfung, die gleich danach beginnt.
      onPage: (p) => {
        if (!p.external) setTimeout(() => ac.abort(), 300);
      },
      onWarn: (m) => warnings.push(m),
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3000, `dauerte ${elapsed} ms`);
  const external = pages.filter((p) => p.external);
  assert.equal(external.length, 1, 'nur die bereits laufende Prüfung kommt zurück');
  assert.equal(external[0]!.status, 200);
  assert.equal(foreign.hits.length, 1, 'nach dem Abbruch keine weitere Prüfung gestartet');
  assert.deepEqual(warnings, []);
});

test('Berichte und diff kennzeichnen einen abgebrochenen Lauf', () => {
  const summary = summarize(7, 'teil', [], [], true);
  assert.equal(summary.aborted, true);
  const note = /Lauf abgebrochen nach 0 Seiten – Ergebnis unvollständig/;
  assert.match(formatConsole(summary), note);
  assert.match(formatMarkdown(summary), note);
  assert.match(formatHtml({ summary, pages: [], generatedAt: '2026-09-29T00:00:00.000Z' }), note);
  // --json schreibt die Zusammenfassung ohne rules – das Feld muss dabei sein.
  assert.equal(JSON.parse(JSON.stringify({ ...summary, rules: undefined })).aborted, true);

  const complete = summarize(8, 'voll', [], []);
  assert.equal(complete.aborted, false);
  assert.doesNotMatch(formatMarkdown(complete), /abgebrochen/);

  const d = diffRuns([], [], [], []);
  assert.match(formatDiff(d, 7, 8, false, [7]), /Lauf #7 wurde abgebrochen/);
  assert.match(formatDiff(d, 7, 8, true, [7]), /> \*\*Lauf #7 wurde abgebrochen/);
  assert.doesNotMatch(formatDiff(d, 7, 8), /abgebrochen/);
});

test('alte DB ohne Spalte aborted wird beim Öffnen migriert und bleibt lesbar', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'seo-crawler-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'alt.sqlite');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, started_at TEXT NOT NULL,
    finished_at TEXT, config TEXT NOT NULL, pages INTEGER, findings INTEGER);
    INSERT INTO runs (name, started_at, finished_at, config, pages, findings)
    VALUES ('alt', '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', '{}', 3, 1);`);
  old.close();

  const store = new Store(file);
  try {
    assert.deepEqual(
      store.listRuns().map((r) => [r.name, r.pages, r.aborted]),
      [['alt', 3, false]],
    );
    const id = store.startRun('neu', {});
    store.finishRun(id, 2, [], true);
    assert.equal(store.getRun(id)?.aborted, true);
  } finally {
    store.close();
  }
  // Zweites Öffnen: Spalte existiert schon, die Migration läuft nicht noch einmal.
  new Store(file).close();
});

function runCli(args: string[], onStderr?: (text: string, child: ChildProcess) => void) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/cli.ts', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => {
    stderr += d;
    onStderr?.(stderr, child);
  });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
    child.on('exit', (code) => resolve({ code, stdout, stderr })),
  );
  return { child, done };
}

// Unter Windows lässt sich einem Kindprozess kein SIGINT zustellen (kill beendet hart) – dort laufen die CLI-Tests nicht.
const noSigint = process.platform === 'win32' ? 'SIGINT an Kindprozesse gibt es unter Windows nicht' : false;

test('CLI: Strg+C speichert Seiten und Befunde, runs zeigt „abgebrochen nach N Seiten“', { skip: noSigint }, async (t) => {
  const fx = await startFixture(SLOW);
  t.after(() => fx.close());
  const dir = mkdtempSync(path.join(tmpdir(), 'seo-crawler-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = path.join(dir, 'runs.sqlite');
  const json = path.join(dir, 'befunde.json');

  let sent = false;
  const { done } = runCli(
    ['crawl', `${fx.origin}/b`, ...SLOW_PATHS.map((p) => fx.origin + p), '--no-follow', '--mode', 'raw', '--db', db, '--json', json],
    (text, child) => {
      if (!sent && text.includes('[1/')) {
        sent = true;
        child.kill('SIGINT');
      }
    },
  );
  const res = await done;
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stderr, /Abbruch – werte bisherige Seiten aus/);

  const store = new Store(db);
  try {
    const [run] = store.listRuns();
    assert.equal(run?.aborted, true);
    assert.ok(run!.finishedAt);
    assert.ok(run!.pages! >= 1 && run!.pages! < 7, `Seiten: ${run!.pages}`);
    assert.equal(store.loadPages(run!.id).length, run!.pages);
    // /b hat keine Meta-Description – der Befund muss trotz Abbruch gespeichert sein.
    assert.ok(store.loadFindings(run!.id).some((f) => f.ruleId === 'meta-description' && pathOf(f.url) === '/b'));
  } finally {
    store.close();
  }
  assert.equal(JSON.parse(readFileSync(json, 'utf8')).summary.aborted, true, '--json kennzeichnet den Abbruch');
  assert.match(res.stdout, /Lauf abgebrochen nach \d+ Seiten/);
  const runs = await runCli(['runs', '--db', db]).done;
  assert.match(runs.stdout, /abgebrochen nach \d+ Seiten/);
});

test('CLI: zweites Strg+C beendet sofort mit Exitcode 130', { skip: noSigint }, async (t) => {
  const fx = await startFixture(SLOW);
  t.after(() => fx.close());
  const dir = mkdtempSync(path.join(tmpdir(), 'seo-crawler-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { child, done } = runCli(
    ['crawl', ...SLOW_PATHS.map((p) => fx.origin + p), '--no-follow', '--mode', 'raw', '--db', path.join(dir, 'r.sqlite')],
    (text, c) => {
      if (text.includes('Abbruch')) c.kill('SIGINT');
    },
  );
  // Erstes SIGINT, sobald ein 2-s-Abruf läuft; das zweite folgt auf die Abbruch-Meldung.
  let firstAt = 0;
  const poll = setInterval(() => {
    if (fx.hits.some((h) => h.startsWith('GET /langsam'))) {
      clearInterval(poll);
      firstAt = Date.now();
      child.kill('SIGINT');
    }
  }, 10);
  const res = await done;
  clearInterval(poll);
  assert.equal(res.code, 130, res.stderr);
  assert.ok(firstAt > 0 && Date.now() - firstAt < 1500, 'nicht auf die laufenden 2-s-Abrufe gewartet');
});
