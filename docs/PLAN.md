# Plan – Meilenstein 2

Stand: M1 ist fertig (Crawler, Rendering, Regel-Engine, SQLite, diff, CLI). Vorher [AGENTS.md](../AGENTS.md) lesen.

**Arbeitsweise:** eine Aufgabe = ein Branch = ein PR. Reihenfolge ist egal, außer wo „Braucht“ steht.
Jede Aufgabe ist fertig, wenn alle Punkte unter „Abnahme“ erfüllt sind und `npm run typecheck` + `npm test` grün sind.
Nichts umsetzen, was unter „Nicht tun“ steht. Unklar? Im PR als offene Frage notieren statt raten.

| # | Aufgabe | Größe | Braucht |
|---|---|---|---|
| T1 | Sauberer Abbruch mit Strg+C | klein | – |
| T2 | HTML-Bericht | mittel | – |
| T3 | Canonical-Ziel prüfen ✅ | klein | – |
| T4 | hreflang prüfen | mittel | – |
| T5 | Verwaiste Seiten und Sitemap-Abgleich | mittel | – |
| T6 | Externe Links prüfen | groß | – |
| T7 | SARIF-Ausgabe ✅ | klein | – |
| T8 | Faire Verteilung über Hosts im Bulk-Modus | mittel | – |

---

## T1 – Sauberer Abbruch mit Strg+C

**Ziel:** Ein abgebrochener Crawl verliert nichts. Bisher bleibt der Lauf ohne `finished_at` und ohne Befunde.

**Dateien:** `src/crawler/crawler.ts`, `src/crawler/frontier.ts`, `src/cli.ts`, `src/store/db.ts`

**Spezifikation**
- `crawl()` bekommt optional `signal?: AbortSignal` in `CrawlHooks` (oder als eigenes Argument).
- Bei Abbruch: keine neuen URLs mehr aus der Frontier ausgeben (`next()` liefert null), laufende Abrufe zu Ende laufen lassen,
  Browser schließen, bisherige Ergebnisse zurückgeben.
- CLI: erstes `SIGINT` → Meldung „Abbruch – werte bisherige Seiten aus …“, Signal auslösen, normal weiter mit Regeln + Speichern.
  Zweites `SIGINT` → sofort beenden (`process.exit(130)`).
- Tabelle `runs` bekommt Spalte `aborted INTEGER NOT NULL DEFAULT 0`. Migration: beim Öffnen prüfen, ob die Spalte fehlt
  (`PRAGMA table_info(runs)`), dann `ALTER TABLE`. Alte DBs müssen weiter funktionieren.
- `runs` zeigt abgebrochene Läufe als „abgebrochen nach N Seiten“; `diff` ohne Argumente überspringt abgebrochene Läufe.

**Randfälle**
- Abbruch, während Chromium noch startet.
- Abbruch, bevor die erste Seite fertig ist → 0 Seiten, Lauf trotzdem abgeschlossen und markiert.
- Abbruch während Sitemap-Laden (Seeds noch nicht fertig).
- Worker hängt in `limiter.run` wegen Crawl-delay → darf den Abbruch nicht minutenlang blockieren (Wartezeit abbrechbar machen).

**Tests:** Crawl gegen den Fixture-Server mit einer Seite, die 2 s verzögert antwortet; nach 200 ms abbrechen → Ergebnis enthält
die bis dahin fertigen Seiten, Aufruf endet in < 3 s.

**Abnahme:** Strg+C im echten Lauf speichert Seiten und Befunde; `runs` zeigt „abgebrochen“; alte DB-Datei lädt ohne Fehler.

**Nicht tun:** Keine Fortsetzung abgebrochener Läufe (Resume) – das ist eine eigene Aufgabe.

---

## T2 – HTML-Bericht

**Ziel:** `crawl … --html bericht.html` und `report [lauf] --html bericht.html` schreiben eine einzelne, eigenständige HTML-Datei.

**Dateien:** neu `src/report-html.ts`, `src/cli.ts`, README

**Spezifikation**
- Eine Datei, **keine externen Ressourcen** (kein CDN, keine Fonts von außen), CSS und JS inline. Muss offline funktionieren.
- Inhalt: Kopf (Name, Lauf-Nr., Datum, Seiten, gerendert, Statusverteilung), Zähler je Schwere,
  Tabelle je Regel (id, Schwere, Anzahl, Beschreibung), darunter alle Befunde.
- Filter per JS: Schwere (Checkboxen), Regel (Auswahl), Suchfeld für URL/Text. Ohne JS muss alles lesbar bleiben.
- Seitenliste: URL, Status, Tiefe, Title, gerendert ja/nein, Anzahl Befunde; sortierbar per Klick auf die Spaltenköpfe.
- Hell- und Dunkelmodus über `prefers-color-scheme`.
- Braucht Regelbeschreibungen → `summarize` bzw. der Aufrufer reicht die `RuleSet`-Beschreibungen durch (für `report` sind die Regeln
  evtl. nicht mehr geladen: dann ohne Beschreibung, nicht abstürzen).

**Randfälle**
- **XSS:** Titles, URLs und Meldungen stammen von fremden Seiten. Alles escapen (`& < > " '`). Test mit
  `<title><script>alert(1)</script></title>` in einer Fixture-Seite – im HTML darf kein ausführbares `<script>` daraus werden.
- Daten als JSON inline einbetten: `</script>` in Strings unschädlich machen (`<` als `<` kodieren).
- 50 000 Befunde: Datei bleibt benutzbar (Liste nicht komplett als DOM rendern oder seitenweise zeigen).
- Leerer Lauf (0 Befunde) → freundlicher Hinweis statt leerer Tabelle.

**Tests:** Datei erzeugen, prüfen: enthält keinen unescapten Fixture-Titel mit `<script>`, enthält jede Regel-id,
keine `http(s)://`-Referenz in `src=`/`href=` von `<script>`/`<link>`.

**Abnahme:** Bericht öffnet offline im Browser, Filter funktionieren, XSS-Test grün.

**Nicht tun:** Kein Framework, kein Build-Schritt, keine Diagramm-Bibliothek.

---

## T3 – Canonical-Ziel prüfen

**Ziel:** Neue Site-Prüfung `canonicalTarget: ok` meldet Canonicals, die ins Leere oder in Ketten zeigen.

**Dateien:** `src/rules/schema.ts` (SiteCheckSchema), `src/rules/engine.ts` (`runSiteRule`), `rules/default.yaml`, README, Tests

**Spezifikation** – für jede Seite mit Canonical ≠ eigene URL, wenn das Ziel gecrawlt wurde:
- Ziel antwortet nicht 2xx → „Canonical zeigt auf <ziel> (404)“
- Ziel ist eine Weiterleitung (`redirects.length > 0` und Canonical ≠ `finalUrl`) → „Canonical zeigt auf Weiterleitung nach …“
- Ziel steht auf noindex → „Canonical zeigt auf noindex-Seite“
- Ziel hat selbst ein Canonical auf eine dritte URL → „Canonical-Kette: a → b → c“
- Ziel nicht gecrawlt → nichts melden (unbekannt, nicht falsch).
- Grundregel `canonical-target` mit Schwere `warning` in `default.yaml`.

**Randfälle:** Canonical auf sich selbst mit anderem Slash/Query (nach `normalizeUrl` vergleichen); Canonical auf fremde Domain
(meldet schon die Seitenregel `canonical` – hier überspringen); Schleife a → b → a (einmal melden, nicht endlos laufen).

**Tests:** Fixture-Seiten für jeden der vier Fälle plus Schleife.

**Abnahme:** Jeder Fall erzeugt genau einen Befund auf der Quellseite; nicht gecrawlte Ziele erzeugen keinen.

---

## T4 – hreflang prüfen

**Ziel:** Site-Prüfung `hreflang: valid` für mehrsprachige Seiten.

**Dateien:** wie T3

**Spezifikation** – nur für Seiten mit mindestens einem hreflang-Eintrag:
- Sprachcode gültig: `x-default` oder `^[a-z]{2,3}(-([A-Za-z]{2}|\d{3}|[A-Za-z]{4}))?$` (Groß/Klein egal) → sonst „ungültiger Code“
- Selbstverweis fehlt (keine Alternate zeigt auf die eigene URL) → Befund
- Doppelter Sprachcode mit unterschiedlichen Zielen → Befund
- Rückverweis: Seite A nennt B für `en`; B wurde gecrawlt, nennt aber A nicht → „fehlender Rückverweis von B“
- Ziel antwortet nicht 2xx oder leitet weiter → Befund
- Kein `x-default` → nur `info`, als eigene Grundregel, damit man sie abschalten kann

**Randfälle:** hreflang auch im HTTP-`Link`-Header oder in der Sitemap – **nicht** in dieser Aufgabe, im PR als Grenze nennen;
Ziel nicht gecrawlt → Rückverweis nicht prüfen; relative hrefs (werden in `extract.ts` schon absolut gemacht).

**Tests:** Paar mit korrektem Rückverweis (kein Befund), Paar ohne Rückverweis, ungültiger Code `english`, fehlender Selbstverweis.

**Abnahme:** Befunde wie spezifiziert, keine Befunde bei korrektem Paar.

---

## T5 – Verwaiste Seiten und Sitemap-Abgleich

**Ziel:** Zwei Site-Prüfungen: Sitemap-URLs, auf die kein Link zeigt (`orphans: sitemap`), und indexierbare Seiten,
die in der Sitemap fehlen (`missingFromSitemap: true`).

**Dateien:** `src/types.ts`, `src/crawler/crawler.ts`, `src/rules/schema.ts`, `src/rules/engine.ts`, `rules/default.yaml`, README, Tests

**Spezifikation**
- `PageResult` bekommt optional `seedSource?: 'url' | 'file' | 'sitemap'` (nur bei Start-URLs gesetzt).
  Taucht eine URL in mehreren Quellen auf, gewinnt `url` vor `file` vor `sitemap`.
- Verwaist: `seedSource === 'sitemap'` und keine gecrawlte Seite verlinkt sie (Link-Ziel nach `normalizeUrl`, auch über
  Weiterleitungen: Link auf `/alt`, das nach `/neu` leitet, zählt als Link auf `/neu`).
- Fehlt in Sitemap: nur wenn in der Config mindestens eine Sitemap angegeben ist; Seite ist `indexable` und nicht per Sitemap gekommen,
  und ihre `finalUrl` steht nicht in der Sitemap-Liste.
- Beide als Grundregeln mit Schwere `info`.

**Randfälle:** Startseite ist nie verwaist, wenn sie als `url` angegeben wurde; Links von noindex-Seiten zählen trotzdem;
`followLinks: false` → Verwaist-Prüfung ergibt keinen Sinn, dann überspringen (nicht jede Seite melden);
Sitemap mit www, Links ohne www (über `siteKey`/normalisieren vergleichen – www und ohne gelten nur beim Host als gleich,
die URLs selbst unterscheiden sich; im PR entscheiden und begründen).

**Tests:** Fixture mit `/sitemap.xml`, die eine unverlinkte Seite enthält; eine verlinkte, aber nicht in der Sitemap stehende Seite.

**Abnahme:** Genau diese beiden Seiten werden gemeldet; mit `--no-follow` keine Verwaist-Befunde.

---

## T6 – Externe Links prüfen

**Ziel:** Optional prüfen, ob ausgehende Links erreichbar sind.

**Dateien:** `src/config.ts`, `src/crawler/crawler.ts`, neu `src/crawler/external.ts`, `src/types.ts`, `src/rules/*`, `src/report.ts`, `src/diff.ts`, README, Tests

**Spezifikation**
- Config `scope.checkExternal: boolean` (Standard `false`), `scope.maxExternal: number` (Standard 500).
- Nach dem Crawl (nicht währenddessen) alle eindeutigen externen Link-Ziele prüfen, jedes genau einmal.
- Erst `HEAD`; bei 405, 501 oder Netzfehler, der nach HEAD-Verweigerung aussieht, einmal `GET` (Body sofort abbrechen).
- Weiterleitungen folgen (bestehenden `fetchPage` wiederverwenden oder um `method` erweitern).
- Eigener `HostLimiter` mit denselben Höflichkeitswerten; robots.txt fremder Hosts wird **nicht** geprüft (einzelner Abruf, kein Crawl).
- Ergebnisse als `PageResult` mit neuem optionalem Feld `external: true`, `raw`/`rendered` = null, `depth` = -1.
  Seitenregeln überspringen `external`-Einträge (in `appliesTo`), `diff` und Seitenzähler im Bericht ebenso (eigene Zahl „extern geprüft“).
- `brokenLinks` akzeptiert zusätzlich `external` (Schema: `z.enum(['internal','external'])`), Grundregel `broken-external-link`, Schwere `warning`.

**Randfälle:** 429 mit `Retry-After` → einmal nach der Wartezeit wiederholen (höchstens 30 s), sonst als „429“ melden;
Seiten, die Bots mit 403 abweisen (LinkedIn, Instagram, Cloudflare-Challenge) → 403 **nicht** als kaputt melden, sondern als
eigene info-Regel `external-link-blocked`; `maxExternal` erreicht → Hinweis ausgeben, welche nicht geprüft wurden;
Links mit `mailto:`, `tel:`, `javascript:` kommen gar nicht erst an (filtert `normalizeUrl` schon – nicht doppelt bauen).

**Tests:** zweiter Fixture-Server als „fremder Host“: 200, 404, 405-bei-HEAD-aber-200-bei-GET, 403, 429 mit `Retry-After: 1`.

**Abnahme:** Nur 404 erzeugt `broken-external-link`, 403 erzeugt `external-link-blocked`, 405-Fall ist ok; ohne `checkExternal` kein einziger externer Abruf.

**Nicht tun:** Externe Seiten nicht rendern und nicht nach Links durchsuchen.

---

## T7 – SARIF-Ausgabe

**Ziel:** `--sarif datei.sarif` für GitHub Code Scanning.

**Dateien:** neu `src/report-sarif.ts`, `src/cli.ts`, `examples/github/seo-check.yml`, README

**Spezifikation**
- SARIF 2.1.0, `tool.driver.name = "seo-crawler"`, `rules` aus den aktiven Regeln (id, shortDescription = description).
- Level: error → `error`, warning → `warning`, info → `note`.
- Code Scanning braucht Dateiorte im Repo: Ort = die Config-Datei (relativer Pfad zum Repo-Root, `region.startLine: 1`),
  die URL steht in `message.text` und in `properties.url`.
- `partialFingerprints.primaryLocationLineHash` = stabiler Hash aus `ruleId + url`, damit dieselbe Meldung über Läufe
  als dieselbe Warnung erkannt wird und behobene sich schließen.
- Beispiel-Workflow um `github/codeql-action/upload-sarif` ergänzen (mit `permissions: security-events: write`).

**Randfälle:** Befunde ohne URL (Plugin-Fehler auf Site-Ebene) → trotzdem gültiges SARIF; Aufruf ohne `-c` (keine Config-Datei)
→ `--sarif` mit klarer Fehlermeldung ablehnen.

**Tests:** Ausgabe gegen die Grundstruktur prüfen (version, runs[0].tool.driver.rules, results[].ruleId existiert in rules);
gleicher Befund zweimal → gleicher Fingerprint.

**Abnahme:** Datei validiert strukturell; Fingerprint stabil.

---

## T8 – Faire Verteilung über Hosts im Bulk-Modus

**Ziel:** Bei einer URL-Liste über viele Domains blockieren Worker nicht auf einem langsamen Host.

**Hintergrund:** Heute nimmt jeder Worker die nächste URL aus einer gemeinsamen Schlange und wartet dann im `HostLimiter`.
Stehen 500 URLs von `a.de` vor 500 von `b.de`, warten alle Worker auf `a.de`, obwohl `b.de` frei wäre.

**Dateien:** `src/crawler/frontier.ts`, `src/crawler/crawler.ts`, ggf. `src/util.ts`

**Spezifikation**
- Frontier hält je Host eine eigene Schlange; `next()` wählt reihum einen Host, der gerade einen freien Platz hat und dessen
  Mindestabstand abgelaufen ist. Gibt es keinen, bis zum frühesten möglichen Zeitpunkt warten (nicht aktiv pollen).
- Verhalten nach außen gleich: Duplikatschutz, `maxPages`, Seeds mit `force`, Ende-Erkennung.
- Reihenfolge innerhalb eines Hosts bleibt Breitensuche (Tiefe aufsteigend).

**Randfälle:** Ein einziger Host (Normalfall) darf nicht langsamer werden; Crawl-delay aus robots.txt wird erst nach dem ersten
Abruf bekannt; Weiterleitungen auf einen anderen Host.

**Tests:** Zwei Fixture-Server, einer mit 300 ms Antwortzeit. 10 URLs vom langsamen, 10 vom schnellen Host, `perHost: 1`,
`concurrency: 4` → die schnellen sind fertig, bevor die Hälfte der langsamen durch ist.

**Abnahme:** Test grün, bestehende Tests unverändert grün, Einzelhost-Crawl nicht messbar langsamer.

---

## Später (nicht in M2)

- Resume abgebrochener Läufe
- hreflang aus HTTP-Header und Sitemap
- Core Web Vitals / Lighthouse pro Seitentyp (Stichprobe)
- Veröffentlichung als npm-Paket mit Build-Schritt (dann ist `bin` möglich)
- Erkennen, welche Seiten `auto` unnötig rendert (Heuristik in `needsRender` schärfen)
