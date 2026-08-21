---
description: Schreibt HANDOFF.md für die Übergabe an ein kleineres lokales Modell
argument-hint: [optionaler Fokus]
allowed-tools: Read, Grep, Glob, Bash(git status:*), Bash(git log:*), Bash(git diff:*), Write
---

Schreibe `HANDOFF.md` im Projektwurzelverzeichnis: eine Arbeitsanweisung für ein
**deutlich schwächeres Modell** (Qwen3.8-27B, lokal über die DeepSeek Harness),
das diese Codebasis nicht kennt, keinen Zugriff auf dieses Gespräch hat und
nichts von dem weiss, was du dir beim Lesen erschlossen hast.

Optionaler Fokus für diese Übergabe: $ARGUMENTS
(Ist er leer, übergib den aktuellen Arbeitsstand.)

## Warum das anders geschrieben wird als für dich

Ein kleines Modell scheitert nicht am Programmieren, sondern am Suchen, am
Kombinieren und am Weglassen. Es liest eine Anweisung wörtlich, füllt Lücken mit
Plausiblem statt mit Richtigem und merkt nicht, wenn es das Falsche geändert hat.
Die Übergabe muss deshalb so geschrieben sein, dass Nachdenken über den Auftrag
gar nicht nötig ist.

## Bindende Regeln für den Text der Übergabe

- **Keine Suchaufträge.** Jede Datei mit vollem Pfad ab Projektwurzel nennen, dazu
  Funktion oder Zeilennummer. Niemals „finde die Stelle, an der …", niemals
  „irgendwo in `app/ui/`".
- **Ein Schritt = eine Änderung an einer Datei.** Alles zerlegen, was du selbst in
  einem Rutsch machen würdest. Lieber acht kleine Schritte als drei grosse.
- **Befehle wörtlich und kopierbar**, in einem eigenen Codeblock, nicht
  beschrieben. Nicht „führe die Tests aus", sondern der exakte Befehl.
- **Kein impliziter Kontext.** Was du aus dem Code erschlossen hast — Konventionen,
  Datenformate, welche Funktion was zurückgibt, welches Feld welche Einheit hat —
  muss dastehen. Wenn du es dir beim Lesen zusammengereimt hast, kann das kleine
  Modell es nicht.
- **Ein eigener Abschnitt „Fallen".** Jede Stelle, an der der naheliegende Weg
  falsch ist, mit Begründung. Ohne Begründung wird die Warnung ignoriert.

## Aufbau von HANDOFF.md

Genau diese Abschnitte, in dieser Reihenfolge:

1. **Auftrag** — ein Satz. Was am Ende anders sein soll.
2. **Stand** — letzter Commit (Hash und Betreff), uncommittete Dateien, was
   bereits funktioniert und was nicht.
3. **Landkarte** — nur die Dateien, die für diesen Auftrag zählen, je eine Zeile:
   voller Pfad, was drinsteht, warum sie hier vorkommt.
4. **Nächste Schritte** — nummeriert. Jeder Schritt nennt: die Datei, die genaue
   Anweisung (bei kleinen Änderungen den alten und den neuen Code wörtlich), den
   exakten Prüfbefehl und die erwartete Ausgabe.
5. **Fallen** — siehe oben.
6. **Befehle** — Build, Test, Lint, Start, jeweils wörtlich.
7. **Nicht anfassen** — Dateien und Bereiche, die unverändert bleiben müssen, mit
   je einem Halbsatz Begründung.

## Vorgehen

1. Zuerst den echten Stand holen, nicht aus dem Gedächtnis schreiben:
   `git status`, `git log --oneline -10`, `git diff --stat`.
2. Dann die betroffenen Dateien **tatsächlich lesen**. Zeilennummern und
   Codeauszüge in der Übergabe müssen stimmen; eine falsche Zeilennummer schickt
   ein kleines Modell in die völlig falsche Richtung.
3. Dann `HANDOFF.md` schreiben.
4. Zum Schluss selbst prüfen: **Könnte jemand ohne jede Vorkenntnis allein mit
   dieser Datei Schritt 1 korrekt ausführen?** Wenn nein, den Schritt weiter
   zerlegen oder den fehlenden Kontext ergänzen — und erst dann fertig melden.

**Obergrenze 500 Zeilen.** Überflüssiger Kontext schadet einem kleinen Modell mehr
als er nützt: er verdünnt die Anweisung, die zählt. Im Zweifel Schritte kürzen,
nie die Präzision.

Zum Schluss ausgeben, welche Schritte in der Übergabe stehen und was davon du
bewusst weggelassen hast.
