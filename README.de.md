**Sprache:** [English](README.md) | Deutsch

# PZ Room Furnisher

Ein Tool zur Unterstützung von Project Zomboid Mod- und Mapentwicklern.
KI wurde verwendet dieses Applikation zu erstellen. Wenn dir das nicht gefällt, dann nutze sie nicht. 

---

## Inhaltsverzeichnis

- [App starten](#app-starten)
- [Aus dem Quellcode starten (Entwickler)](#aus-dem-quellcode-starten-entwickler)
- [Bedienung: Gebäude & Einstellungen](#bedienung-gebäude--einstellungen)
  - [🏠 Gebäude-Tab](#-gebäude-tab)
  - [⚙ Einstellungen](#-einstellungen)
- [Räume & Möbel-Einstellungen](#räume--möbel-einstellungen)

---

## App starten

Keine Installation von .NET, Node oder sonst etwas nötig — einfach herunterladen und starten.

1. Auf der [Releases-Seite](https://github.com/simonmd82/pz-room-furnisher/releases) das Zip für dein System herunterladen:
   - **Windows** – `PzRoomFurnisher-win-x64.zip`
   - **Linux** – `PzRoomFurnisher-linux-x64.zip`
2. Zip entpacken.
3. **Windows** – Doppelklick auf `PzRoomFurnisher.exe`. Ein Konsolenfenster öffnet sich, der Browser öffnet automatisch die App.
4. **Linux** – im entpackten Ordner im Terminal:
   ```bash
   chmod +x PzRoomFurnisher
   ./PzRoomFurnisher
   ```
   Der Standardbrowser sollte automatisch öffnen; falls nicht, `http://localhost:5000` manuell öffnen.
5. Zum Beenden das Konsolenfenster schließen (Windows) bzw. Ctrl+C im Terminal drücken (Linux).

Einstellungen und Konfiguration werden neben der ausführbaren Datei im Ordner `Data/` gespeichert.

---

## Aus dem Quellcode starten (Entwickler)

| Tool | Version |
|------|---------|
| .NET SDK | 10.0+ |
| Node.js | 18+ |
| npm | 9+ |

### Backend

```powershell
cd backend
dotnet run
```

Das Backend läuft standardmäßig auf `http://localhost:5000`.

### Frontend

```powershell
cd frontend
npm install
npm run dev
```

Das Frontend läuft standardmäßig auf `http://localhost:5173`.

Alternativ können die mitgelieferten Skripte genutzt werden:

```powershell
.\run-frontend.ps1   # oder run-frontend.cmd
```

---

## Bedienung: Gebäude & Einstellungen

### 🏠 Gebäude-Tab

Der Einstiegspunkt der Anwendung. Hier wird ein **Project Zomboid `.tbx`-Gebäudefile** geladen und visualisiert.
Zur Zeit kann es ausschließlich Wohngebäude möblieren. Standardmäßig nutzt es Vanilla-Möbel, zusätzlich können Melos- und Simon_MD-Tiles aktiviert werden (siehe [Tile-Sets](#tile-sets)).

**Was es kann:**

- **`.tbx`-Upload** – Parst das Gebäudeformat des PZ Building Editors (bis 10 MB).
- **Gebäude-Info** – Zeigt Abmessungen (Breite × Höhe), Stockwerkanzahl und Gesamt-/Stockwerk-Raumanzahl.
- **Stockwerk-Navigation** – Wechsel zwischen allen vorhandenen Stockwerken.
- **Grid-Renderer** – Visualisiert das Raumgitter als farbiges Kachel-Grid mit SVG-Overlay.
  - Türen (orange) und Fenster (cyan) werden als Balken auf den Wänden dargestellt.
  - Treppen werden gestreift dargestellt, der Einstiegspunkt mit einem ✕ markiert.
  - Tooltip je Zelle mit Raumname, Tür-/Fensterinfo und Koordinaten.
- **Grid- und ISO-Ansicht** – Oberhalb des Gebäudes lässt sich zwischen dem Grid von oben und einer isometrischen Ansicht wie in Project Zomboid wechseln. Die ISO-Ansicht dient nur zum Betrachten und braucht den in den Einstellungen gesetzten PZ-Tiles-Ordner. Wände, Türen und Fenster lassen sich in voller Höhe oder als niedrige Stümpfe anzeigen.
- **Zoomen & Verschieben** – Zoom-Buttons (−, %, +, Fit) oder Strg + Mausrad am Mauszeiger. Die Ansicht lässt sich mit der mittleren Maustaste verschieben, oder mit der linken Maustaste überall außer auf Möbeln.
- **Möbel verschieben** – Nach dem Möblieren lassen sich platzierte Möbel an eine andere Stelle ziehen (nur in der Grid-Ansicht).
- **Raumauswahl** – Einzelklick oder Ctrl+Klick (Multi-Select) um Räume hervorzuheben / auszublenden.
- **A\*-Wegfindung** – Berechnet beim Upload automatisch für jeden Raum den kürzesten Weg zwischen allen Tür-Waypoints (mit kleinem Zufalls-Jitter für optische Variation).
  - Treppen-Zellen werden beim Routing ausgenommen; nur der Einstiegspunkt ist passierbar.
  - Kostengefälle: offene Fläche > wandnahe Zellen > Ecken.
- **Wege anzeigen** – Toggle zum Ein-/Ausblenden der berechneten Wege als farbige Punkte im Grid.
- **Weg neu generieren** – Per Klick auf 🔄 im Raumlegende-Eintrag wird der Weg eines einzelnen Raums mit neuem Zufalls-Seed neu berechnet (ohne Reload).

**Vorbereitung der TBX Datei**

Erstelle ein Wohngebäude im BuildEd, mit Türen, Fenstern, offenen Mauern und speichere es als `.tbx`-Datei.
Lass dabei das Gebäude unmöbliert.

**Wie man es bedient:**

Ziehe die TBX Datei in den Container im Gebäude-Tab. Das Gebäude wird nun sichtbar und kann bearbeitet werden.
Mach dich mit der Legende oberhalb der Gebäude-UI vertraut.
In der linken Spalte kannst du nun entweder alle Räume eines Typs auswählen oder Räume einzeln selektieren die möbliert werden sollen. 
Wähle unter "Möbel-Konfigurationsquellen" aus, welche Tile-Sets verwendet werden.
Bestimme mit den Reglern unterhalb der Liste der Räume die Dichte wie stark möbliert werden soll. Jeder Raum bekommt dann eine eigene prozentuale Dichte-Anzahl, abhängig von deiner Auswahl.
Wenn jeder Raum gleich stark möbliert werden soll, dann selektiere die Checkbox oberhalb des Buttons.
Sollen alle Räume maximal möbliert werden, setze beide Regler auf 100%.
Wenn du mit deiner Auswahl zufrieden bist, dann klicke auf den Button und warte bis der Algorithmus durchgelaufen ist. Dies kann je nach Größe des Gebäudes durchaus 1-2 Minuten dauern.
Bei kleinen Gebäuden dauert dies nur ein paar Sekunden.
Ein Fortschrittsdialog zeigt die Räume, während sie möbliert werden. "Stopp" beendet den Lauf nach dem aktuellen Raum, bereits fertige Räume bleiben erhalten.
Im Anschluss kannst du dir das Ergebnis ansehen und wenn das für dich passt, es mit dem "TBX Export" Button exportieren als neue TBX Datei und anschließend wieder in TileEd öffnen.
Die Möbel werden dabei alle im "Tilemode" platziert.

**Aktuell Unterstützte Raumtypen:**
- `bathroom`
- `bedroom`
- 'closet'
- `diningroom`
- `kitchen`
- 'laundry'
- `livingroom`
- `office`
- `garagestorage`
- `hall`

#### Tile-Sets

| Set | Standard | Status |
|---|---|---|
| Vanilla | an | Möbel des Basisspiels |
| Melos | aus | Enthalten, noch nicht zu 100% fertig |
| Simon_MD | aus | Enthalten, noch nicht zu 100% fertig |

Ein Set wird im Gebäude-Tab unter "Möbel-Konfigurationsquellen" aktiviert oder deaktiviert. Beim Möblieren werden nur aktivierte Sets verwendet.
Melos und Simon_MD sind noch nicht vollständig konfiguriert, daher werden manche ihrer Möbel nicht platziert. Ein exportiertes Gebäude, das sie nutzt, braucht diese Tile-Packs außerdem in deinen Tools und im Spiel.

---

### ⚙ Einstellungen

Globale Listen, die von anderen Tabs genutzt werden.

**Was es kann:**

- **Bekannte Raumtyp-Namen** – Zentrales Register aller Raumtyp-Bezeichner (wird im Tile Browser und Raumtypen-Editor verwendet).
- **Bekannte Kategorien** – Zentrales Register aller Tile-Kategorien (wird im Raumtypen-Editor als Kategorie-Auswahl angeboten).
- Einträge können hinzugefügt und entfernt werden (mit Bestätigungsdialog).

---

## Räume & Möbel-Einstellungen

Diese Tabs sind für die Konfiguration des automatischen Möblierungs-Generators gedacht und normalerweise hinter einem Erweitert-Schalter verborgen.

### 🖼 Tile Browser

Werkzeug zum Erfassen und Konfigurieren von **Sprite-Tiles** aus den PZ-Texturordnern.

**Was es kann:**

- **Pfadkonfiguration** – Pfad zum `media/textures`-Ordner des Spiels setzen. Wird persistent gespeichert.
- **Verzeichnis-Browser** – Grafischer Datei-Browser (navigiert über das Backend durch das Dateisystem – Laufwerke, Ordner).
- **Sheet-Liste** – Listet alle `.png`-Sprite-Sheets im konfigurierten Ordner auf, mit Suchfilter.
  - Zeigt Badge `definiert / gesamt` je Sheet.
- **Sheet-Viewer** – Rendert das vollständige Sprite-Sheet mit Zoom (0,5× / 1× / 1,5× / 2×).
  - Bereits definierte Sprites werden hervorgehoben.
  - Ausgewähltes Sprite wird markiert.
  - Bei aktivem Layout-Zuweisungsmodus zeigt ein Hinweisbalken die aktive Zelle.
- **Tile-Konfiguration** – Klick auf ein Sprite öffnet den Konfigurationsbereich:
  - **Label** – Anzeigename
  - **Gruppe** – Kategorie (vordef. + eigene; per Chip auswählen oder neu eingeben)
  - **Orientierung** – N / S / E / W oder beliebig
  - **Höhe** – low / high (Mehrfachauswahl)
  - **Layer** – Furniture, Wallfurniture, FloorOverlay, … (10 Layer)
  - **Flags** – `blocksPathing`, `wallMounted`, `canStack`
  - **Notizen** – Freitext
- **Multi-Tile Layout-Editor** – Definiert, aus welchen Sprites ein mehrzelliges Möbelstück besteht.
  - Beliebige Raster-Größe (Spalten + Zeilen dynamisch anpassbar).
  - Zelle anklicken → aktivieren → Sprite im Sheet anklicken → automatisches Weiterspringen zur nächsten Zelle.
  - Zellen können einzeln geleert werden.
  - Mini-Vorschau je Zelle direkt aus dem Sprite-Sheet.
- **Zufallsgenerator-Metadaten:**
  - **Farben** – Chip-Auswahl (white, black, brown, …)
  - **Raumtypen** – welche Räume dieses Tile verwenden dürfen
  - **Varianten-ID** – Gruppiert farbliche/stilistische Varianten desselben Möbeltyps
  - **Style-Tags** – Modern, Rustic, … (gespeichert, noch nicht im Generator aktiv)
  - **Raumtypen-Filter** – Tiles mit mindestens einem Raumtyp-Eintrag werden nur in passenden Räumen verwendet. Tiles ohne Raumtyp-Eintrag gelten als neutral und sind überall erlaubt.
- **Speichern / Löschen** – Jede Definition wird als JSON auf dem Backend persistiert.
- **Export** – Download der gesamten `tile-definitions.json` per Link.

---

### 📋 Furniture Browser

Lesezugriff auf **BuildingFurniture-Dateien** (`.bf`-Format von Project Zomboid) zur Massenimport-Unterstützung.

**Was es kann:**

- **Pfad-Konfiguration** – Pfad zu einer `.bf`-Datei setzen (z. B. `BuildingFurniture_01.bf`). Wird persistent gespeichert.
- **Verzeichnis-Browser** – Gleicher Datei-Browser wie im Tile Browser.
- **Gruppen-Liste** – Listet alle `group`-Blöcke der Datei mit Bezeichnung, Piece-Anzahl und Entry-Anzahl auf.
  - Suchfilter.
- **Detail-Ansicht** – Zeigt alle `furniture`-Einträge (Pieces) einer Gruppe mit ihren Orientierungen und Tile-IDs.
  - Mini-Sprite-Vorschauen aus den gecachten Sprite-Sheets.
- **Multi-Select** – Mehrere Entries gleichzeitig auswählen (Checkboxen, auch je Piece).
- **Import als Tile-Definition** – Ausgewählte Entries werden als TileDefinition-Entwürfe aus der `.bf`-Struktur abgeleitet und können direkt konfiguriert und gespeichert werden.
  - Bereits importierte Tiles werden mit einem Indikator markiert.
  - **Konfigurationsfelder wie im Tile Browser** (Gruppe, Farben, Raumtypen, Varianten-ID, Style-Tags, Flags, Notizen).
    - Tiles mit gesetzten Raumtypen werden nur in passenden Räumen verwendet; leere Raumtypen = überall erlaubt.

---

### 🏠 Raumtypen-Editor

Definiert, welche Möbel-Slots ein Raum eines bestimmten Typs haben soll – als Grundlage für einen künftigen automatischen Raumdekorierer.

**Was es kann:**

- **Raumtyp-Verwaltung** – Liste aller bekannten Raumtypen. Neue Typen anlegen oder bestehende entfernen (inkl. Löschung gespeicherter Konfiguration).
- **Slot-System** – Jeder Raumtyp besitzt eine beliebige Zahl an Slots. Ein Slot ist eine „Anfrage" an den Generator:
  - **Fußabdruck (B × H)** – Wie viele Zellen das Möbelstück belegt (1×1 bis 5×5).
  - **Drehbar** – Bei nicht-quadratischen Footprints kann B und H getauscht werden. Mini-Visualisierung beider Orientierungen.
  - **Pflicht / Optional** – Pflicht-Slots werden immer befüllt.
  - **Priorität** – Optionale Slots werden in Prioritätsreihenfolge gezogen (0 = zuerst).
  - **Anzahl je Raumgröße** – Min/Max-Tabelle für XS / S / M / L / XL (Max -1 = unbegrenzt).
  - **Erlaubte Kategorien** – Welche Tile-Gruppen für diesen Slot infrage kommen, mit Gewichtung (1–10).
  - **Platzierungsregeln** – An der Wand / An einer Tür / An einem Fenster / Raummitte / Nur in Ecken / Auf Pfadzellen erlaubt.
  - **Wandausrichtung** (nur bei „An der Wand"): Automatisch / ⊥ Senkrecht / ∥ Parallel.
  - **Fallback-Regeln** – Geordnete Liste alternativer Platzierungsregeln. Findet der Generator mit den primären Regeln keine freie Position, versucht er die Fallbacks der Reihe nach (nur für Pflicht-Slots relevant).
  - **Layer-Filter** – Schränkt auf einen bestimmten Furniture-Layer ein.
  - **Erforderliche Eigenschaften** – z. B. `blocksPathing`, `wallMounted`, `canStack`.
  - **Varianten-Gruppe (one-of)** – Mehrere Slots in einer Gruppe → Generator wählt genau eine Variante (gewichtet).
  - **Anker-Slot** – Verknüpft diesen Slot relativ zu einem anderen (z. B. Nachttisch „HeadLeft" neben dem Bett).
- **Raumtypen-Filter im Generator** – Tiles werden beim Möblieren automatisch auf den aktuellen Raumtyp gefiltert. Nur Tiles, deren `RoomTypes`-Liste den Raumtyp enthält oder die keine Einschränkung haben (leere Liste), werden ausgewählt.
- **Slot duplizieren** – Schnelles Kopieren eines bestehenden Slots.
- **Info-Panel** – Einblendbare Erklärung aller Slot-Konzepte.
- **Referenz-Footer** – Zeigt häufige Footprint-Raster und die Raumgrößen-Skala als Nachschlage-Leiste.
- **Speichern / Löschen** – Konfigurationen werden als JSON auf dem Backend persistiert.
