---
mode: agent
description: Arbeitet docs/PLAN.md Aufgabe für Aufgabe ab – Branch, Umsetzung, Tests, PR, Merge.
---

Du arbeitest selbstständig die Aufgaben aus `docs/PLAN.md` ab. Lies zuerst `AGENTS.md` und `docs/PLAN.md` vollständig.

## Umgebung

Windows, **Windows PowerShell 5.1**. Kein `&&` und kein `||` – Befehle mit `;` trennen oder `if ($?) { … }`.
Mehrzeilige Commit-Nachrichten: in eine Datei schreiben und `git commit -F datei` verwenden.

## Reihenfolge

T3 → T7 → T2 → T4 → T5 → T6 → T1 → T8.
Überspringe Aufgaben, die in `docs/PLAN.md` schon mit `✅` markiert sind.

## Ablauf je Aufgabe

1. `git checkout main; git pull`
2. `git checkout -b <nr>-<kurzname>` (z. B. `t3-canonical-target`)
3. Umsetzen – genau nach Spezifikation, alle Randfälle, die geforderten Tests. Nichts aus „Nicht tun“.
4. `npm run typecheck` und `npm test`. Bei Fehlern korrigieren. **Höchstens 3 Korrekturrunden** – danach aufhören, siehe „Abbruch“.
5. README anpassen, wo sich Nutzung oder Regeln ändern. In `docs/PLAN.md` die Zeile der Aufgabe in der Übersichtstabelle mit `✅` markieren.
6. Committen (Nachricht: `T3: Canonical-Ziel prüfen` plus kurze Aufzählung), `git push -u origin <branch>`
7. `gh pr create --fill --base main` – im PR-Text: was umgesetzt ist, welche Randfälle getestet sind, offene Fragen.
8. `gh pr checks --watch` abwarten.
   - **T1 und T8:** nicht mergen. PR offen lassen, weiter zur nächsten Aufgabe (oder Ende).
   - Alle anderen: wenn grün, `gh pr merge --squash --delete-branch`. Wenn rot: Log lesen (`gh run view --log-failed`), auf dem Branch korrigieren, pushen, erneut abwarten – zählt zu den 3 Korrekturrunden.

## Abbruch

Hör auf und schreib eine Zusammenfassung, wenn:
- eine Aufgabe nach 3 Korrekturrunden nicht grün ist (Branch und PR stehen lassen, im PR beschreiben, woran es hängt),
- die Spezifikation widersprüchlich ist oder eine Entscheidung verlangt, die nicht im Plan steht,
- ein bestehender Test nur durch Ändern oder Löschen des Tests grün würde.

**Niemals:** bestehende Tests abschwächen oder löschen, Force-Push, direkt auf `main` committen, neue Abhängigkeiten ohne Begründung,
Netzwerkzugriffe in Tests außer gegen den Fixture-Server.

## Zum Schluss

Tabelle: Aufgabe | PR | Status (gemergt / offen / abgebrochen) | Anmerkung.
