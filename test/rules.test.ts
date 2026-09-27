import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { type EvalContext, evalCheck } from '../src/rules/engine.ts';
import { loadRules } from '../src/rules/load.ts';

const ctx = (fields: Record<string, unknown>, extra: Partial<EvalContext> = {}): EvalContext => ({
  fields,
  raw: null,
  rendered: null,
  pageHost: 'example.com',
  ...extra,
});

test('length, range und exists', () => {
  assert.deepEqual(evalCheck({ field: 'title', length: { min: 5, max: 10 } }, ctx({ title: 'Hallo' })), []);
  assert.equal(evalCheck({ field: 'title', length: { max: 3 } }, ctx({ title: 'Hallo' })).length, 1);
  assert.equal(evalCheck({ field: 'title', exists: true }, ctx({ title: '' })).length, 1);
  assert.equal(evalCheck({ field: 'n', range: { max: 1 } }, ctx({ n: 2 })).length, 1);
});

test('matches: Arrays, Groß/Klein und /flags/', () => {
  assert.deepEqual(evalCheck({ field: 'h1', matches: 'rosen' }, ctx({ h1: ['Tulpen', 'ROSEN'] })), []);
  assert.equal(evalCheck({ field: 'h1', matches: '/rosen/' }, ctx({ h1: ['ROSEN'] })).length, 1);
  assert.equal(evalCheck({ field: 'metaRobots', notMatches: 'noindex' }, ctx({ metaRobots: 'NOINDEX, follow' })).length, 1);
});

test('any, all und not erben das Feld', () => {
  const check = { field: 'canonical', any: [{ exists: false }, { sameHost: true }] };
  assert.deepEqual(evalCheck(check, ctx({ canonical: null })), []);
  assert.deepEqual(evalCheck(check, ctx({ canonical: 'https://www.example.com/x' })), []);
  assert.equal(evalCheck(check, ctx({ canonical: 'https://fremd.de/x' })).length, 1);
  assert.equal(evalCheck({ field: 'path', not: { matches: '^/intern' } }, ctx({ path: '/intern/x' })).length, 1);
});

test('stableAcrossRender vergleicht roh und gerendert', () => {
  const raw = { title: 'A' };
  const rendered = { title: 'B' };
  assert.equal(evalCheck({ field: 'title', stableAcrossRender: true }, ctx(rendered, { raw, rendered })).length, 1);
  assert.deepEqual(evalCheck({ field: 'title', stableAcrossRender: true }, ctx(raw, { raw, rendered: null })), []);
});

test('Regeldateien: Tippfehler und kaputte Regex werden vor dem Crawl gemeldet', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'seo-rules-'));
  await writeFile(
    path.join(dir, 'kaputt.yaml'),
    'rules:\n  - id: a\n    check: { field: title, lenght: { max: 5 } }\n  - id: b\n    check: { field: title, matches: "(" }\n',
  );
  const config = parseConfig({ rules: ['./kaputt.yaml'] }, dir);
  await assert.rejects(loadRules(config), (err: Error) => /lenght/.test(err.message) && /ungültige Regex/.test(err.message));
});

test('spätere Datei und ruleOverrides überschreiben Grundregeln', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'seo-rules-'));
  await writeFile(path.join(dir, 'eigen.yaml'), 'rules:\n  - id: title-length\n    check: { field: title, length: { min: 10, max: 70 } }\n');
  const config = parseConfig(
    { rules: ['builtin:default', './eigen.yaml'], ruleOverrides: { lang: { enabled: false }, 'image-alt': { severity: 'error' } } },
    dir,
  );
  const rules = await loadRules(config);
  assert.equal(rules.page.find((r) => r.id === 'title-length')?.check.length?.max, 70);
  assert.ok(!rules.page.some((r) => r.id === 'lang'));
  assert.equal(rules.page.find((r) => r.id === 'image-alt')?.severity, 'error');
});
