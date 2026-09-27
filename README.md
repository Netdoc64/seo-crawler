# seo-crawler

Universeller SEO-Crawler mit JavaScript-Rendering, Regel-Engine und Vergleich zwischen Läufen.
Läuft lokal (Hauptbetrieb) und als GitHub-Check für eigene Seiten. Keine Cloud, keine laufenden Kosten.

## Schnellstart

Voraussetzung: Node.js 24+.

```powershell
npm install
npm run setup                     # lädt Chromium für das Rendern (einmalig)
npm run crawl -- https://example.com/ --max-pages 50
```

Ohne Browser: `--mode raw`. Nur eine URL-Liste prüfen, ohne Links zu folgen: `--url-file urls.txt --no-follow`.

## Was er tut

| Baustein | Verhalten |
|---|---|
| Abruf | folgt Weiterleitungen selbst und hält jede Stufe fest; Header, Antwortzeit, Größe |
| Rendern | Chromium über Playwright. `auto` rendert nur, wenn das rohe HTML nach JS-App aussieht; `render` immer; `raw` nie |
| Roh vs. gerendert | beide Fassungen werden gespeichert; Regeln mit `stableAcrossRender` melden, was erst durch JavaScript entsteht |
| Höflichkeit | robots.txt samt Crawl-delay, Parallelität pro Host, Mindestabstand |
| Umfang | Start über URLs, URL-Datei oder Sitemap (auch Index und .gz); Host-, Pfad- und Tiefenfilter |
| Speicher | jeder Lauf als Snapshot in SQLite (`node:sqlite`) |
| Nachverfolgung | `diff` zeigt neue/verschwundene Seiten, geänderte Felder, neue und behobene Befunde |
| Ausgabe | Konsole, Markdown, JSON, SARIF; in GitHub Actions zusätzlich Job-Zusammenfassung und Annotationen |

## Befehle

| Befehl | Zweck |
|---|---|
| `crawl [url …] [-c config.yaml]` | crawlen, prüfen, speichern |
| `rules [-c config.yaml]` | aktive Regeln anzeigen, Regeldateien prüfen |
| `runs` | gespeicherte Läufe |
| `report [lauf]` | Bericht eines Laufs erneut ausgeben |
| `diff [von] [bis]` | zwei Läufe vergleichen, Standard: die letzten zwei gleichen Namens |

Aufruf über `npm run cli -- <befehl> …`, alle Optionen mit `npm run cli -- help`.
`--fail-on error|warning|info` setzt den Exitcode 1, sobald ein Befund dieser Schwere auftritt.
`--sarif datei.sarif` schreibt die Befunde als SARIF 2.1.0 für GitHub Code Scanning. Code Scanning braucht Dateiorte
im Repo – als Ort dient die Config-Datei, die URL steht in der Meldung. Deshalb geht `--sarif` nur zusammen mit `-c`.
Über `partialFingerprints` erkennt GitHub dieselbe Meldung über Läufe hinweg und schließt behobene automatisch.
`--html bericht.html` (bei `crawl` und `report`) schreibt einen eigenständigen HTML-Bericht ohne externe Ressourcen:
Filter nach Schwere und Regel, Suche in URL und Text, sortierbare Seitenliste, Hell/Dunkel über `prefers-color-scheme`.
Bei `report` sind die Regelbeschreibungen nur enthalten, wenn sie noch bekannt sind – sonst bleibt die Spalte leer.

## Konfiguration

Siehe [examples/example.yaml](examples/example.yaml). Alle Felder sind optional; relative Pfade gelten relativ zur Config-Datei.

## Regeln

Regeln sind YAML, Grundregeln in [rules/default.yaml](rules/default.yaml). Eigene Dateien kommen in der Config unter `rules:` dazu;
eine gleiche `id` in einer späteren Datei ersetzt die frühere. Einzelne Regeln abschalten oder die Schwere ändern: `ruleOverrides`.

```yaml
rules:
  - id: product-structured-data
    severity: error                     # error | warning | info
    applies: { path: ["/produkte/**"] } # auch: exclude, status, html, indexable
    source: raw                         # effective (Standard) | raw | rendered
    when: { field: noindex, equals: false }
    check: { field: jsonLdTypes, contains: Product }
    message: "Kein Product-Markup ({detail})"
```

| Operator | Bedeutung |
|---|---|
| `exists` | Wert vorhanden (nicht leer) bzw. nicht vorhanden |
| `length` `{min,max}` | Länge eines Textes oder einer Liste |
| `range` `{min,max}` | Zahlenbereich |
| `equals` / `notEquals` / `oneOf` | Gleichheit |
| `matches` / `notMatches` | Regex, Groß/Klein egal; `/muster/flags` für genaue Flags; bei Listen reicht ein Treffer |
| `contains` | Text enthält, Liste enthält Element |
| `sameHost` | URL zeigt auf dieselbe Domain |
| `stableAcrossRender` | Wert ist roh und gerendert gleich |
| `all` / `any` / `not` | kombinieren; Unterprüfungen erben `field` |

Felder für `field`: `title`, `metaDescription`, `metaRobots`, `canonical`, `lang`, `h1`, `headings`, `hreflang`, `og.<name>`,
`jsonLdTypes`, `jsonLdErrors`, `links`, `images`, `wordCount`, `status`, `redirectCount`, `redirects`, `headers.<name>`,
`timeMs`, `bytes`, `path`, `url`, `depth`, `xRobotsTag`, `noindex`, `canonicalIsSelf`, `indexable`, `h1Count`,
`imagesMissingAlt`, `internalLinks`, `externalLinks`, `rendered`, `error`, `renderError`.

Seitenübergreifende Regeln (`scope: site`): `unique: <feld>`, `brokenLinks: internal`, `redirectingLinks: internal`,
`canonicalTarget: ok` (Canonical zeigt auf Fehlerseite, Weiterleitung, noindex-Seite oder bildet eine Kette;
Ziele, die nicht gecrawlt wurden, gelten als unbekannt und erzeugen keinen Befund),
`hreflang: valid` (Sprachcodes, Selbstverweis, doppelte Codes, Rückverweis, Ziel-Status; nur Seiten mit hreflang)
und `hreflang: x-default` (nur der Hinweis, dass x-default fehlt – als eigene Regel separat abschaltbar).
hreflang aus HTTP-`Link`-Header oder Sitemap wird nicht ausgewertet, nur das HTML.
`orphans: sitemap` (Sitemap-URL, auf die kein interner Link zeigt; Links über Weiterleitungen zählen aufs Ziel;
entfällt bei `followLinks: false`) und `missingFromSitemap: true` (indexierbare Seite fehlt in der Sitemap –
nur aktiv, wenn mindestens eine Sitemap konfiguriert ist). Start-URLs merken sich ihre Herkunft
(`url` schlägt `file` schlägt `sitemap`); www und nackte Domain gelten als dieselbe Site, die URLs selbst
werden exakt (nach `normalizeUrl`) verglichen.

### Plugins

Reicht YAML nicht, ein TS-Modul mit `checkPage` und/oder `checkSite` schreiben und unter `plugins:` eintragen –
Beispiel: [examples/plugins/insecure-links.ts](examples/plugins/insecure-links.ts).

## Als GitHub-Check

Vorlage: [examples/github/seo-check.yml](examples/github/seo-check.yml). Empfehlung: in einem **privaten** Repo mit den
Site-Configs laufen lassen – bei öffentlichen Repos sind Logs, Zusammenfassungen und Artefakte für alle sichtbar.
GitHub Actions nur für eigene Seiten nutzen, nicht als allgemeiner Crawler für fremde Seiten.

## Entwicklung

Konventionen: [AGENTS.md](AGENTS.md) · offene Aufgaben: [docs/PLAN.md](docs/PLAN.md)

```powershell
npm run typecheck
npm test
```

TypeScript läuft direkt über Node (Type Stripping) – kein Build-Schritt. Deshalb nur „erasable“ Syntax:
keine `enum`, keine Parameter-Properties, Importe mit `.ts`-Endung.
