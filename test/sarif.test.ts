import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fingerprint, formatSarif } from '../src/report-sarif.ts';
import type { Finding } from '../src/types.ts';

const findings: Finding[] = [
  { ruleId: 'title', severity: 'error', url: 'https://example.com/a', message: 'title fehlt' },
  { ruleId: 'thin-content', severity: 'info', url: 'https://example.com/b', message: 'nur 12 Wörter' },
  { ruleId: 'plugin-x', severity: 'error', url: '', message: 'Plugin-Fehler: kaputt' },
];

test('SARIF: Grundstruktur, Levels und Regeln', () => {
  const doc = JSON.parse(formatSarif(findings, [{ id: 'title', description: 'Seite hat einen Title' }], 'sites/example.yaml'));
  assert.equal(doc.version, '2.1.0');
  const driver = doc.runs[0].tool.driver;
  assert.equal(driver.name, 'seo-crawler');
  const ruleIds = driver.rules.map((r: { id: string }) => r.id);
  for (const f of findings) assert.ok(ruleIds.includes(f.ruleId), `Regel ${f.ruleId} fehlt`);
  assert.equal(driver.rules.find((r: { id: string }) => r.id === 'title').shortDescription.text, 'Seite hat einen Title');

  const results = doc.runs[0].results;
  assert.equal(results.length, 3);
  assert.equal(results[0].level, 'error');
  assert.equal(results[1].level, 'note');
  assert.match(results[0].message.text, /https:\/\/example\.com\/a/);
  assert.equal(results[0].properties.url, 'https://example.com/a');
  assert.equal(results[0].locations[0].physicalLocation.artifactLocation.uri, 'sites/example.yaml');
  assert.equal(results[0].locations[0].physicalLocation.region.startLine, 1);

  // Befund ohne URL (Site-Ebene) ist trotzdem gültig.
  assert.equal(results[2].message.text, 'Plugin-Fehler: kaputt');
  assert.equal(results[2].properties.url, '');
});

test('SARIF: Fingerprint ist stabil und unterscheidet Regel und URL', () => {
  const a = fingerprint('title', 'https://example.com/a');
  assert.equal(a, fingerprint('title', 'https://example.com/a'));
  assert.notEqual(a, fingerprint('title', 'https://example.com/b'));
  assert.notEqual(a, fingerprint('other', 'https://example.com/a'));

  const doc = JSON.parse(formatSarif([findings[0]!], [], 'c.yaml'));
  assert.equal(doc.runs[0].results[0].partialFingerprints.primaryLocationLineHash, a);
});
