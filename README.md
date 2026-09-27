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
| Ausgabe | Konsole, Markdown, JSON; in GitHub Actions zusätzlich Job-Zusammenfassung und Annotationen |

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
Ziele, die nicht gecrawlt wurden, gelten als unbekannt und erzeugen keinen Befund).

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
