# Hinweise für KI-Agenten und Mitwirkende

Lies das vor der ersten Änderung. Die Aufgaben stehen in [docs/PLAN.md](docs/PLAN.md) – immer **eine** Aufgabe pro Branch/PR.

## Befehle

```powershell
npm install
npm run setup        # Chromium für Playwright, einmalig
npm run typecheck    # muss fehlerfrei sein
npm test             # muss grün sein
npm run cli -- help
```

Ein PR ist erst fertig, wenn `npm run typecheck` und `npm test` lokal durchlaufen.

## Laufzeit und Sprache – harte Regeln

- **Node 24, TypeScript ohne Build.** Node führt `.ts` direkt aus (Type Stripping). Deshalb:
  - Importe **mit `.ts`-Endung**: `import { x } from './url.ts'`
  - **Kein** `enum`, **keine** Parameter-Properties (`constructor(private x)`), kein `namespace`
    – `tsconfig` hat `erasableSyntaxOnly`, der Typecheck schlägt sonst fehl
  - Reine Typ-Importe mit `import type` (`verbatimModuleSyntax`)
  - Private Felder als `#feld`, nicht `private feld`
- **Keine neuen Abhängigkeiten** ohne Begründung im PR. Vorhanden: `playwright`, `cheerio`, `yaml`, `zod` (v4), `robots-parser`.
  Datenbank ist `node:sqlite` (eingebaut), Tests sind `node:test` + `node:assert/strict`.
- **zod v4**: verschachtelte Objekte mit Defaults brauchen `.prefault({})`, nicht `.default({})`.
  Schemas sind `.strict()` – unbekannte Schlüssel sind ein Fehler, das ist gewollt (Tippfehler in Regeln).
- `robots-parser` ist CommonJS mit falschen Typen – siehe Kommentar in `src/crawler/robots.ts`, nicht „reparieren“.
- Nutzertexte (Befunde, Fehlermeldungen, CLI-Ausgaben) sind **Deutsch**. Code, Bezeichner: Englisch.
- Kommentare sparsam und nur für das Warum, im Stil der bestehenden Dateien.

## Aufbau

| Datei | Aufgabe |
|---|---|
| `src/cli.ts` | Befehle, Argumente, Ausgabe |
| `src/config.ts` | Config-Schema (zod), Laden, CLI-Überschreibungen |
| `src/crawler/crawler.ts` | Ablauf: Seeds → Frontier → Abruf → ggf. Rendern → Links einreihen |
| `src/crawler/fetcher.ts` | HTTP-Abruf, Weiterleitungen manuell |
| `src/crawler/renderer.ts` | Chromium über Playwright |
| `src/crawler/frontier.ts` | Warteschlange, Duplikatschutz, Seitenlimit |
| `src/crawler/robots.ts`, `sitemap.ts` | robots.txt, Sitemaps |
| `src/extract.ts` | HTML → `Snapshot` |
| `src/rules/schema.ts` | Regel-Schema (zod) und Typen |
| `src/rules/fields.ts` | Felder, die Regeln per `field` ansprechen |
| `src/rules/engine.ts` | Auswertung Seiten- und Site-Regeln, Plugins |
| `src/rules/load.ts` | Regeldateien laden, prüfen, überschreiben |
| `src/store/db.ts` | SQLite: runs, pages, findings |
| `src/report.ts`, `src/diff.ts` | Berichte, Lauf-Vergleich |
| `rules/default.yaml` | Grundregeln |
| `test/fixture.ts` | lokaler HTTP-Server mit Testseiten – für neue Fälle hier Seiten ergänzen |

## Invarianten – nicht brechen

- `PageResult` wird als JSON in SQLite gespeichert. Neue Felder **optional** machen oder mit Default lesen,
  damit alte Läufe weiter ladbar sind (`report`, `diff` auf alte DB).
- Rohes HTML wird **immer** abgerufen; `rendered` ist zusätzlich. `effective = rendered ?? raw`.
- Seitenregeln laufen standardmäßig nur auf HTML mit Status 2xx und vorhandenem Snapshot (`appliesTo` in `engine.ts`).
- `robotsBlocked`-Seiten werden nie bewertet.
- Alle URLs laufen durch `normalizeUrl` (ohne Fragment, ohne Tracking-Parameter) – vergleiche nie rohe hrefs.
- `www.` und ohne `www.` gelten als dieselbe Site (`siteKey`).
- Neue Regel-Operatoren: Schema (`schema.ts`) + Auswertung (`engine.ts`) + `VALUE_OPS`/Lint (`load.ts`) + README-Tabelle + Test.
- Inhalte fremder Seiten (Titles, URLs, Texte) sind **nicht vertrauenswürdig**: in HTML/Markdown/XML-Ausgaben immer escapen.

## Tests

- Jede Aufgabe bringt Tests mit; Netzwerk nur gegen den Fixture-Server (`startFixture()`), nie gegen echte Seiten.
- Tests, die Chromium brauchen, überspringen sich selbst, wenn es fehlt (Muster in `test/crawl.test.ts`).
- `politeness: { delayMs: 0 }` in Tests, sonst werden sie langsam.
