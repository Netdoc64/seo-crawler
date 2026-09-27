import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Finding, PageResult, Severity } from '../types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  config TEXT NOT NULL,
  pages INTEGER,
  findings INTEGER
);
CREATE TABLE IF NOT EXISTS pages (
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  final_url TEXT NOT NULL,
  status INTEGER NOT NULL,
  depth INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (run_id, url)
);
CREATE TABLE IF NOT EXISTS findings (
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  url TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS findings_run ON findings(run_id, rule_id);
`;

export interface RunInfo {
  id: number;
  name: string;
  startedAt: string;
  finishedAt: string | null;
  pages: number | null;
  findings: number | null;
}

/** Jeder Lauf ist ein Snapshot – Grundlage für den Vergleich zweier Läufe. */
export class Store {
  #db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.#db = new DatabaseSync(file);
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.#db.exec(SCHEMA);
  }

  startRun(name: string, config: unknown): number {
    const r = this.#db
      .prepare('INSERT INTO runs (name, started_at, config) VALUES (?, ?, ?)')
      .run(name, new Date().toISOString(), JSON.stringify(config));
    return Number(r.lastInsertRowid);
  }

  savePage(runId: number, p: PageResult): void {
    this.#db
      .prepare('INSERT OR REPLACE INTO pages (run_id, url, final_url, status, depth, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(runId, p.url, p.finalUrl, p.status, p.depth, JSON.stringify(p));
  }

  finishRun(runId: number, pages: number, findings: Finding[]): void {
    const insert = this.#db.prepare('INSERT INTO findings (run_id, rule_id, severity, url, message) VALUES (?, ?, ?, ?, ?)');
    this.#db.exec('BEGIN');
    try {
      this.#db.prepare('DELETE FROM findings WHERE run_id = ?').run(runId);
      for (const f of findings) insert.run(runId, f.ruleId, f.severity, f.url, f.message);
      this.#db
        .prepare('UPDATE runs SET finished_at = ?, pages = ?, findings = ? WHERE id = ?')
        .run(new Date().toISOString(), pages, findings.length, runId);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  listRuns(name?: string): RunInfo[] {
    const sql = `SELECT id, name, started_at, finished_at, pages, findings FROM runs ${name ? 'WHERE name = ?' : ''} ORDER BY id DESC`;
    const rows = (name ? this.#db.prepare(sql).all(name) : this.#db.prepare(sql).all()) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      name: String(r.name),
      startedAt: String(r.started_at),
      finishedAt: r.finished_at === null ? null : String(r.finished_at),
      pages: r.pages === null ? null : Number(r.pages),
      findings: r.findings === null ? null : Number(r.findings),
    }));
  }

  getRun(id: number): RunInfo | null {
    return this.listRuns().find((r) => r.id === id) ?? null;
  }

  loadPages(runId: number): PageResult[] {
    return (this.#db.prepare('SELECT data FROM pages WHERE run_id = ? ORDER BY rowid').all(runId) as { data: string }[]).map(
      (r) => JSON.parse(r.data) as PageResult,
    );
  }

  loadFindings(runId: number): Finding[] {
    const rows = this.#db
      .prepare('SELECT rule_id, severity, url, message FROM findings WHERE run_id = ? ORDER BY rowid')
      .all(runId) as Record<string, string>[];
    return rows.map((r) => ({ ruleId: r.rule_id!, severity: r.severity as Severity, url: r.url!, message: r.message! }));
  }

  close(): void {
    this.#db.close();
  }
}
