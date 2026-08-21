# Arbeitsanweisung für Agenten

Diese Datei gilt dauerhaft. Der jeweilige Arbeitsstand steht in `HANDOFF.md`.

## Sessionstart

1. `HANDOFF.md` im Projektwurzelverzeichnis lesen. Gibt es sie nicht, nach der
   Aufgabe fragen und nichts ändern.
2. Die Schritte unter „Nächste Schritte" **der Reihe nach** abarbeiten, einen nach
   dem anderen.
3. Nach **jedem** Schritt den dort genannten Prüfbefehl ausführen und die Ausgabe
   mit der erwarteten vergleichen. Erst dann der nächste Schritt.

## Befehle

```bash
npm run check       # prüft Manifest und dass jeder Import auflösbar ist
npm run dev         # Entwicklungsserver auf http://localhost:5175
npm run test-files  # erzeugt die Beispiel-PDFs für die Tests (einmalig)
npm run package     # check + Erweiterung bauen und spiegeln
```

Es gibt **keinen Build-Schritt, kein `node_modules` und keinen Linter**. Die
Bibliotheken liegen fertig in `vendor/`, geholt von `npm run vendor`.

### Tests

Die Tests laufen **im Browser**, nicht auf der Kommandozeile:
`npm run dev` starten, dann <http://localhost:5175/tests/> öffnen. Die Seite
zeigt am Ende „All N tests passed" oder die fehlgeschlagenen Fälle.

Kannst du keinen Browser öffnen, dann führe `npm run check` aus und **schreibe
ausdrücklich dazu, dass die Testsuite nicht gelaufen ist**. Niemals behaupten,
die Tests seien grün, wenn du sie nicht gesehen hast.

Es sind Round-Trip-Tests: jeder Fall schreibt ein echtes PDF, liest es zurück und
vergleicht es mit der Vorschau. Fast jeder Fehler hier ist ein Koordinatenfehler,
und nur so fällt er auf.

## Regeln

- **Nur Dateien ändern, die in `HANDOFF.md` genannt sind.** Fällt dir unterwegs
  etwas anderes auf, notiere es im Bericht, ändere es nicht.
- **„Nicht anfassen" in `HANDOFF.md` ist bindend.**
- **Keine neuen Abhängigkeiten** — kein npm-Paket, kein CDN, keine neue Datei in
  `vendor/`. Eine Chrome-MV3-Erweiterung darf ohnehin nur lokale Skripte laden.
- **Sämtliche Koordinatenrechnung gehört in `app/core/geometry.js`.** Wenn du
  irgendwo sonst eine Drehung, einen Versatz oder eine Umrechnung schreibst, ist
  genau das der Fehler.
- **Bestehenden Stil übernehmen**: ES-Module, keine Frameworks, Kommentare
  erklären das Warum in ganzen Sätzen, nicht das Was. Sieh dir die Nachbardatei
  an und schreib wie sie.
- **Bei Unklarheit nachfragen statt raten.** Eine plausible Erfindung ist hier
  teurer als eine Rückfrage.

## Wenn ein Schritt scheitert

Nicht weiterprobieren, nicht auf einen anderen Weg ausweichen, den Schritt nicht
überspringen. Stattdessen:

1. Den Fehler **wörtlich** melden — die vollständige Ausgabe, nicht
   zusammengefasst.
2. Dazuschreiben, bei welchem Schritt und in welcher Datei es passiert ist.
3. Auf Anweisung warten.
