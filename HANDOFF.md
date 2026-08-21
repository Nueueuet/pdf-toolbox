# HANDOFF

## Auftrag

Vier Verbesserungen an den Panels **Split** und **Merge** in einer einzigen
Datei (`app/tools/organize.js`) plus etwas CSS: unlöschbare `.pdf`-Endung,
Warnung bei doppelten Namen, einzeln abwählbare Teile beim Splitten, und
umbenennbare Dateien in der Merge-Liste.

## Stand

- Letzter Commit: `5e837e4` — „Übergabe an ein kleineres lokales Modell"
- Uncommittet: `HANDOFF.md` (diese Datei). Sonst nichts.
- Alles funktioniert, 56 Tests grün. Du baust auf einem sauberen Stand auf.
- Die Aufgaben hier sind **voneinander unabhängig**. Geht Schritt 3 schief,
  bleiben Schritt 1 und 2 trotzdem gültig.

Es gibt **keinen Build-Schritt und kein `node_modules`**. Du änderst Quelldateien,
die der Browser direkt lädt.

## Landkarte

| Datei | Was drin ist | Warum sie hier vorkommt |
| --- | --- | --- |
| `app/tools/organize.js` | Die Panels Merge, Split, Remove, Rotate, Mirror, Crop. Ein Objekt je Werkzeug mit einer `panel(ctx)`-Funktion, die DOM zurückgibt. | **Alle vier Schritte spielen hier.** Merge ab Zeile 58, Split ab Zeile 131. |
| `app/styles.css` | Sämtliches CSS der App, eine Datei. Die Zeilen für `.partrow` / `.filerow` stehen ab Zeile 1481. | Schritt 1 und 2 brauchen je eine kleine Regel. |
| `app/ui/controls.js` | Die Bausteine für Panels: `field`, `textInput`, `checkbox`, `hint`, `button`, `section`. | Du benutzt sie, du änderst sie nicht. |
| `app/util/format.js` | `baseName(fileName)` — entfernt eine `.pdf`-Endung und liefert sonst `'document'`. Zeile 15. | Schritt 1 baut darauf auf. |
| `app/util/dom.js` | `h(tag, props, ...children)` baut DOM-Knoten, `clear(el)` leert einen. `h('div.partrow', …)` erzeugt ein `div` mit der Klasse `partrow`. | Jede Zeile UI in dieser Datei benutzt das. |
| `app/core/download.js` | `saveMany(entries, {zipName, zipThreshold})` speichert eine Liste `{name, data}`. | Schritt 3 gibt ihr weniger Einträge, mehr nicht. |

## Nächste Schritte

Arbeite sie **der Reihe nach** ab. Nach jedem Schritt der Prüfbefehl.

---

### Schritt 1 — Die `.pdf`-Endung ist unlöschbar

**Datei:** `app/tools/organize.js` und `app/styles.css`

Im Namensfeld eines Teils steht heute `bild 1.pdf`, und man kann die Endung
löschen. Sie soll gar nicht mehr im Feld stehen: im Feld nur `bild 1`, direkt
dahinter ein unveränderliches graues `.pdf`.

**1a.** In `app/tools/organize.js`, in `renderPreview()` (etwa Zeile 210): Das
Feld bekommt den Namen **ohne** Endung, und hinter dem Feld steht ein neues
`span`. Aus

```js
        preview.appendChild(h('div.partrow',
          name,
          h('span.partrow__meta', from === to ? `page ${from}` : `pages ${from}–${to}`),
        ));
```

wird

```js
        preview.appendChild(h('div.partrow',
          name,
          h('span.partrow__ext', '.pdf'),
          h('span.partrow__meta', from === to ? `page ${from}` : `pages ${from}–${to}`),
        ));
```

**1b.** Direkt darüber, im selben `ranges.forEach`, wird der Wert des Feldes von
der Endung befreit. Aus

```js
        const name = h('input.partrow__name', {
          value: nameFor(index),
```

wird

```js
        const name = h('input.partrow__name', {
          value: baseName(nameFor(index)),
```

`baseName` ist in dieser Datei schon importiert (Zeile 13), du musst nichts
hinzufügen.

**1c.** In `app/styles.css`, hinter die Zeile

```css
.filerow__meta, .partrow__meta { font-size: 12px; color: var(--ink-faint); white-space: nowrap; }
```

diese Regel einfügen:

```css
/* Die Endung gehört nicht dem Benutzer: eine PDF-Datei heißt .pdf. */
.partrow__ext {
  font-size: 13px;
  color: var(--ink-faint);
  margin-left: -4px;
  white-space: nowrap;
}
```

**Nicht ändern:** `nameFor(index)` selbst und die Zeile in `run()`, die
`` `${chosen}.pdf` `` anhängt. Die hängen die Endung beim Speichern an, und genau
das soll so bleiben. Siehe „Fallen".

**Prüfen:**

```bash
npm run check
```

Erwartete Ausgabe: `ok — 43 modules, manifest v3, AI upscaler installed`

---

### Schritt 2 — Doppelte Namen werden rot und gemeldet

**Datei:** `app/tools/organize.js` und `app/styles.css`

Vergibt man zweimal denselben Namen, überschreibt die zweite Datei die erste,
ohne dass es jemand merkt. Beide Felder sollen rot werden und eine Zeile
darunter soll es sagen.

**2a.** In `app/tools/organize.js` ganz oben, direkt **vor** `const merge = {`
(Zeile 58), diese Funktion einfügen:

```js
/**
 * Welche der Namen mehr als einmal vorkommen.
 *
 * Verglichen wird ohne Rücksicht auf Groß- und Kleinschreibung und ohne
 * umgebende Leerzeichen: Windows hält „Bild 1.pdf" und „bild 1.pdf" für
 * dieselbe Datei, also würde die zweite die erste stillschweigend ersetzen.
 *
 * @param {string[]} names
 * @returns {Set<number>} die Indizes der doppelten Einträge
 */
function duplicateNames(names) {
  const seen = new Map();
  const clash = new Set();
  names.forEach((name, index) => {
    const key = String(name ?? '').trim().toLowerCase();
    if (!key) return;
    if (seen.has(key)) {
      clash.add(seen.get(key));
      clash.add(index);
    } else {
      seen.set(key, index);
    }
  });
  return clash;
}
```

**2b.** In `renderPreview()`: Vor dem `ranges.forEach(...)` die Namen einmal
sammeln, danach die betroffenen Felder markieren. Die Funktion sieht nach der
Änderung so aus (die Zeilen, die du hinzufügst, sind mit `// NEU` markiert —
den Kommentar `// NEU` selbst **nicht** übernehmen):

```js
    const renderPreview = () => {
      clear(preview);
      const ranges = ctx.ws.splitRanges();
      if (ranges.length < 2) {
        preview.appendChild(hint('Add at least one cut point to split the document.'));
        return;
      }
      const clash = duplicateNames(ranges.map((_, index) => baseName(nameFor(index)))); // NEU
      ranges.forEach(([from, to], index) => {
        const name = h('input.partrow__name', {
          value: baseName(nameFor(index)),
          ...
        });
        if (clash.has(index)) name.classList.add('is-clashing');                        // NEU
        preview.appendChild(h('div.partrow',
          name,
          h('span.partrow__ext', '.pdf'),
          h('span.partrow__meta', from === to ? `page ${from}` : `pages ${from}–${to}`),
        ));
      });
      if (clash.size) {                                                                  // NEU
        preview.appendChild(h('p.partlist__warning',                                     // NEU
          'Zwei Teile heißen gleich — so überschreibt der zweite den ersten.'));          // NEU
      }                                                                                  // NEU
    };
```

Die `...` steht für die Zeilen, die schon da sind (`spellcheck`, `readOnly`,
`aria-label`, `title`, `oninput`). Lass sie unverändert stehen.

**2c.** Damit die Warnung beim Tippen sofort erscheint: In der `oninput`-Funktion
des Feldes, direkt hinter `else chosenNames.delete(index);`, den Aufruf
`renderPreview();` ergänzen.

**2d.** In `app/styles.css`, direkt hinter die Regeln für
`input.partrow__name:focus`, einfügen:

```css
input.partrow__name.is-clashing {
  border-color: var(--danger);
  color: var(--danger);
}

.partlist__warning {
  margin: 6px 2px 0;
  font-size: 12.5px;
  color: var(--danger);
}
```

**Prüfen:**

```bash
npm run check
```

Erwartete Ausgabe: `ok — 43 modules, manifest v3, AI upscaler installed`

---

### Schritt 3 — Einzelne Teile abwählen

**Datei:** `app/tools/organize.js`

Beim Splitten werden immer alle Teile gespeichert. Jeder Teil bekommt ein
Häkchen, und gespeichert wird nur, was angehakt ist.

**3a.** Neben `chosenNames` (Zeile 177) eine zweite Ablage anlegen:

```js
    /**
     * Welche Teile abgewählt wurden, nach Teilnummer.
     *
     * Wie `chosenNames` außerhalb des DOM, weil die Liste bei jeder Bewegung
     * eines Schnitts neu gebaut wird und ein Häkchen darin sonst verloren ginge.
     * Gespeichert wird, was *nicht* hier drinsteht — so ist der Normalfall
     * „alles speichern" auch ohne einen einzigen Eintrag richtig.
     */
    const skipped = new Set();
```

**3b.** In `renderPreview()`, in dem `h('div.partrow', ...)`-Aufruf, **vor**
`name` ein Häkchen einfügen:

```js
        const keep = h('input.partrow__keep', {
          type: 'checkbox',
          checked: !skipped.has(index),
          'aria-label': `Part ${index + 1} speichern`,
          onchange: () => {
            if (keep.checked) skipped.delete(index);
            else skipped.add(index);
          },
        });
```

und dann `keep` als erstes Kind von `div.partrow` einsetzen, vor `name`.

**3c.** In `run()` (Zeile ~289) wird die Liste gefiltert. Aus

```js
      const ranges = ctx.ws.splitRanges();
      if (ranges.length < 2) {
        return toast('Add at least one cut point first', { tone: 'error' });
      }
      const result = { ranges };
```

wird

```js
      const all = ctx.ws.splitRanges();
      if (all.length < 2) {
        return toast('Add at least one cut point first', { tone: 'error' });
      }
      /*
       * Die Nummer eines Teils bleibt seine Nummer, auch wenn Teile davor
       * abgewählt sind: der Name kommt aus `nameFor(index)`, und würde nach dem
       * Filtern neu gezählt, hieße der dritte Teil plötzlich „bild 1".
       */
      const ranges = all.filter((_, index) => !skipped.has(index));
      if (ranges.length === 0) {
        return toast('Kein Teil ausgewählt', { tone: 'error' });
      }
      const result = { ranges: all };
```

**3d.** In der Schleife darunter steht `for (const [index, [from, to]] of
result.ranges.entries())`. Sie muss weiterhin über **alle** Teile laufen, damit
`index` und damit `nameFor(index)` stimmen, aber die abgewählten überspringen.
Als erste Zeile im Schleifenrumpf einfügen:

```js
          if (skipped.has(index)) continue;
```

Und die Fortschrittsanzeige darunter — `progress.update(index / result.ranges.length, …)`
— unverändert lassen.

**Prüfen:**

```bash
npm run check
```

Erwartete Ausgabe: `ok — 43 modules, manifest v3, AI upscaler installed`

---

### Schritt 4 — Dateien in der Merge-Liste umbenennen

**Datei:** `app/tools/organize.js`

Die Zeilen unter „Files" im Merge-Panel zeigen den Dateinamen heute als
unveränderlichen Text. Er soll ein Eingabefeld sein: ein Klick irgendwo auf die
Zeile — auch neben den Text — setzt den Cursor hinein. Nur der Knopf „Remove"
bleibt ein Knopf.

In `renderList()` (Zeile ~81), aus

```js
        list.appendChild(h('div.filerow',
          h('span.filerow__name', { title: source?.name }, source?.name ?? 'Unknown'),
```

wird

```js
        const rename = h('input.partrow__name', {
          type: 'text',
          value: baseName(source?.name ?? 'Unknown'),
          spellcheck: 'false',
          'aria-label': 'Dateiname',
          title: 'Klicken zum Umbenennen',
          oninput: () => {
            const typed = rename.value.trim();
            if (!source || !typed) return;
            source.name = `${typed}.pdf`;
            /*
             * Bei genau einer Datei ist ihr Name der Name des Dokuments: was
             * beim Speichern herauskommt, ist ja diese eine Datei.
             */
            if (counts.size === 1) {
              ctx.ws.name = typed;
              ctx.app.onPagesChanged();
            }
          },
        });
        const row = h('div.filerow',
          rename,
          h('span.partrow__ext', '.pdf'),
```

Der Rest der Zeile (`filerow__meta` und der Remove-Knopf) bleibt, wie er ist —
sie werden jetzt Kinder von `row`, und statt `list.appendChild(h('div.filerow', …))`
steht am Ende `list.appendChild(row);`.

Damit ein Klick **neben** den Text auch trifft, bekommt die Zeile noch:

```js
        row.addEventListener('pointerdown', (event) => {
          // Der Remove-Knopf ist ein Knopf und bleibt einer.
          if (event.target.closest('button')) return;
          if (event.target !== rename) rename.focus();
        });
```

**Prüfen:**

```bash
npm run check
```

Erwartete Ausgabe: `ok — 43 modules, manifest v3, AI upscaler installed`

---

## Fallen

- **Die Endung wird zweimal angehängt, wenn du sie nicht wegnimmst.** In `run()`
  steht `` entries.push({ name: /\.pdf$/i.test(chosen) ? chosen : `${chosen}.pdf` … }) ``.
  Diese Zeile ist richtig und bleibt. Deshalb darf `nameFor` weiterhin einen
  Namen *mit* Endung liefern — nur das **Eingabefeld** zeigt ihn ohne. Wer
  stattdessen `nameFor` ändert, bricht die Musterbenennung `{n}`.
- **`chosenNames` speichert, was der Benutzer getippt hat — jetzt ohne Endung.**
  Das ist in Ordnung, weil `run()` die Endung anhängt. Häng sie nicht zusätzlich
  in `oninput` an, sonst steht sie beim nächsten Neuzeichnen im Feld.
- **`renderPreview()` baut die Liste bei jeder Änderung komplett neu.** Alles,
  was der Benutzer eingegeben hat, muss außerhalb des DOM leben (`chosenNames`,
  `skipped`), sonst ist es beim nächsten Tastendruck weg. Leg keine Zustände in
  Attribute der Zeilen.
- **`skipped` speichert das Abwählen, nicht das Auswählen.** Umgekehrt herum
  wäre eine frisch gebaute Liste leer und würde nichts speichern.
- **Beim Filtern der Teile nicht neu durchnummerieren.** Der Name hängt am Index
  in der *vollständigen* Liste. Deshalb läuft die Schleife in `run()` über alle
  und überspringt einzelne, statt über eine gefilterte Liste zu laufen.
- **`ctx.ws.name` ist der Name ohne Endung.** `baseName()` entfernt sie, das
  Speichern hängt sie an. Schreib nie `ctx.ws.name = 'irgendwas.pdf'`.
- **Das Umbenennen einer Datei ist kein `ctx.commit(...)`.** Rückgängig arbeitet
  auf der Seitenliste, nicht auf den Quelldateien; ein Commit dafür würde ein
  leeres Undo erzeugen. Direkt zuweisen ist hier richtig.
- **`checkbox()` aus `controls.js` passt hier nicht.** Die liefert ein `label`
  mit Text daneben; in einer Zeile brauchst du ein nacktes `input`. Deshalb steht
  in Schritt 3 `h('input.partrow__keep', { type: 'checkbox' })`.
- **Umlaute in Bezeichnern vermeiden**, in Zeichenketten sind sie erwünscht. Die
  Datei ist UTF-8, schreib die Texte richtig aus.

## Befehle

```bash
npm run check       # Manifest und alle Importe — muss nach jedem Schritt laufen
npm run dev         # Entwicklungsserver auf http://localhost:5175
npm run test-files  # erzeugt die Beispiel-PDFs (nur einmal nötig)
```

Die Testsuite läuft **im Browser**: `npm run dev`, dann
<http://localhost:5175/tests/> öffnen; am Ende steht „All 56 tests passed".
Kannst du keinen Browser öffnen, führe `npm run check` aus und **schreib
ausdrücklich dazu, dass die Testsuite nicht gelaufen ist**. Behaupte niemals,
Tests seien grün, die du nicht gesehen hast. Die Suite deckt diese vier Schritte
ohnehin nicht ab — sie prüft Koordinaten, nicht Panels. Die eigentliche Prüfung
macht ein Mensch im Browser.

## Nicht anfassen

- `app/core/geometry.js` — sämtliche Koordinatenrechnung. Hier ist nichts zu tun.
- `app/core/counter.js` — die Zählmarken `{n}` `{a}` `{A}` `{i}` `{I}`. Funktioniert
  und ist durch Tests abgedeckt.
- `app/core/download.js`, `app/core/export.js` — Schritt 3 gibt `saveMany` nur
  weniger Einträge.
- `app/ui/pageviewer.js`, `app/ui/pagegrid.js`, `app/main.js` — daran arbeitet
  jemand anderes gleichzeitig (Split und Merge im Viewer, Vorausladen im
  Einzelseitenmodus). Änderungen dort geben Konflikte.
- `manifest.json`, `vendor/`, `scripts/` — nicht Teil dieser Aufgabe.
- Die Werkzeuge `remove`, `rotate`, `mirror`, `crop` in derselben Datei.

## Wenn etwas nicht aufgeht

Melde den Fehler wörtlich, mit Schrittnummer und Datei, und warte auf Anweisung.
Weiche nicht auf einen anderen Weg aus und überspringe keinen Schritt.
