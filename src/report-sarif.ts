import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Finding, Severity } from './types.ts';

export interface SarifRuleInfo {
  id: string;
  description?: string;
}

const LEVEL: Record<Severity, string> = { error: 'error', warning: 'warning', info: 'note' };

/** Stabiler Hash aus Regel und URL: dieselbe Meldung gilt über Läufe als dieselbe Warnung. */
export function fingerprint(ruleId: string, url: string): string {
  return createHash('sha256').update(`${ruleId}${url}`).digest('hex').slice(0, 32);
}

/**
 * SARIF 2.1.0 für GitHub Code Scanning. Code Scanning braucht Dateiorte im Repo –
 * die gecrawlte URL ist kein Dateiort, deshalb zeigt der Ort auf die Config-Datei
 * und die URL steht in der Nachricht.
 */
export function formatSarif(findings: Finding[], rules: SarifRuleInfo[], configPath: string): string {
  const byId = new Map(rules.map((r) => [r.id, r]));
  // Auch Regeln aufführen, die nur in den Befunden auftauchen (z. B. Plugin-Fehler).
  for (const f of findings) if (!byId.has(f.ruleId)) byId.set(f.ruleId, { id: f.ruleId });

  const artifactLocation = {
    uri: configPath.split(path.sep).join('/'),
    uriBaseId: 'SRCROOT',
  };

  const doc = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'seo-crawler',
            informationUri: 'https://github.com/Netdoc64/seo-crawler',
            rules: [...byId.values()].map((r) => ({
              id: r.id,
              shortDescription: { text: r.description ?? r.id },
            })),
          },
        },
        results: findings.map((f) => ({
          ruleId: f.ruleId,
          level: LEVEL[f.severity],
          message: { text: f.url ? `${f.url} – ${f.message}` : f.message },
          properties: { url: f.url },
          partialFingerprints: { primaryLocationLineHash: fingerprint(f.ruleId, f.url) },
          locations: [
            {
              physicalLocation: {
                artifactLocation,
                region: { startLine: 1 },
              },
            },
          ],
        })),
      },
    ],
  };
  return JSON.stringify(doc, null, 2) + '\n';
}
