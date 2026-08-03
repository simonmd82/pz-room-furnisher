# Platzierungslogik – FurnishingGeneratorService

Datei: `backend/Services/FurnishingGeneratorService.cs`

---

## Neu seit Mai 2026: Instanz-spezifische Raumauswahl + Layout Full-Fit

### 1) RoomSelection unterstützt Rauminstanzen

`RoomSelection` enthält zusätzlich optionale Anchor-Koordinaten:

- `anchorCol`
- `anchorRow`

Damit kann bei mehrfach vorkommendem `roomIndex1Based` auf einem Floor genau die
gewählte zusammenhängende Komponente adressiert werden.

### 2) Raumzellen-Bestimmung in `Generate`

Statt pauschal alle Zellen mit gleicher Room-ID zu nehmen, nutzt der Generator jetzt:

```csharp
GetRoomCells(floor, roomIndex1Based, anchorCol, anchorRow)
```

Verhalten:

- ohne Anchor: Legacy-Verhalten (alle Zellen der Room-ID)
- mit Anchor: nur die verbundene Komponente dieser Anchor-Zelle
- wenn Anchor nicht zu dieser Room-ID gehört: Raumdurchlauf wird geskippt

Zusätzlich werden die Pfadzellen auf die gewählte Instanz begrenzt:

```csharp
pathCells.IntersectWith(roomCells)
```

### 3) Placements tragen Instanz-Metadaten

`PlacedFurnitureItem` enthält jetzt optional:

- `roomIndex1Based`
- `anchorCol`
- `anchorRow`

Diese Metadaten werden sowohl in der normalen Slot-Platzierung als auch im
Composite-Layout-Commit mitgeführt.

### 4) LayoutVariants: Option A (Composite Full-Fit)

Für `layoutVariants` läuft vor der klassischen Slotlogik ein vollständiger
Layout-Solver:

1. Variante gewichtet wählen (`SelectLayoutVariant`)
2. vollständige Varianten-Reihenfolge bauen (`BuildLayoutAttemptOrder`)
3. komplette Platzierung als Ganzes suchen (`TryPlaceCompositeLayout` / `SearchCompositeLayout`)
4. nur bei vollständigem Erfolg committen
5. sonst Fallback auf bestehende Slot-by-Slot-Logik

Damit bleibt die bewährte Einzelslot-Logik erhalten, aber zusammenhängende
Layouts (line/L/U etc.) können global-validiert platziert werden.

---

## Pool-Slot-System – Layout-Randomisierung (Juni 2026)

### Konzept

Bisher legte `LayoutVariant.slotIds` exakt fest, welche Slots aktiv sind. Damit war zwar *welche* Variante (L-Shape, Linie, U-Shape) zufällig, aber der Inhalt jeder Position war fix. Das Pool-System erlaubt, einen Arm einer Küchenzeile mit N Slots zu füllen, wobei die *Typen* (Herd, Spüle, einfache Theke) zufällig verteilt werden.

Eckstücke/Strukturelemente bleiben weiterhin fest in `slotIds`. Pools definieren die variablen Positionen.

### Datenmodell

```
LayoutPool
  id / label
  totalCountBySize: { XS..XL: { min, max } }   ← Anzahlbereich pro Raumgröße
  anchorTarget: string              ← Slot-ID, an den Pool-Slot 0 ankert
  firstAnchorPosition / firstOrient ← Anker-Position/-Orient für Slot 0
  chainAnchorPosition / chainOrient ← Anker-Position/-Orient für Slot N → N+1
  requiredLayer / defaultCategories / requiredProperties / …  (Tile-Filter)
  tileGroupId / colorGroupId / materialGroupId
  requiredSlots: LayoutPoolRequiredSlot[]   ← garantierte Typen
  
LayoutPoolRequiredSlot
  category (z.B. "Cooking") → wird zu AllowedCategories: { category: weight }
  count     ← wie oft dieser Typ mindestens erscheint
  label / requiredLayer / requiredProperties
  blocksFrontCell / blocksPlacement / softBlocks
  companions: LayoutPoolCompanion[]

LayoutPoolCompanion
  anchorPosition (z.B. "Center") / orient
  allowedCategories / requiredProperties / requiredLayer / label
  blocksFrontCell / blocksPlacement / softBlocks
```

`LayoutVariant` hat jetzt `disabled?: boolean` – wenn `true`, wird die Variante in `SelectLayoutVariant` und `BuildLayoutAttemptOrder` herausgefiltert (vorübergehend deaktivieren, ohne löschen).

### `ExpandPoolSlots` (FurnishingGeneratorService.cs)

Erzeugt ephemere `RoomTypeSlot`-Instanzen zur Laufzeit (nicht in `config.Slots` gespeichert):

```
pro pool:
  countRange = pool.TotalCountBySize[roomSize]
  totalCount = max(countRange.Min, countRange.Max - countStep)
  wenn 0 → skip

  positionTypes = List<RequiredSlot?>
    für jeden requiredSlot: count-mal eintragen (bis totalCount)
    Rest mit null auffüllen (→ DefaultCategories)
  ShuffleCopy(positionTypes)

  für i = 0..totalCount-1:
    slotId       = "{pool.Id}_{i}"
    anchorTarget = i==0 ? pool.AnchorTarget : "{pool.Id}_{i-1}"
    anchorPos    = i==0 ? firstAnchorPosition : chainAnchorPosition
    layer        = rs.RequiredLayer (wenn nicht leer) sonst pool.RequiredLayer
    → RoomTypeSlot { Required=true, AnchorRules=[...], RequiresSlot=anchorTarget }
    
    für jede companion von rs:
      companionId = "{slotId}_companion_{ci}"
      → RoomTypeSlot { RequiresSlot=slotId, AnchorRules=[anchorTarget=slotId, pos=Center] }
```

Rückgabe-Reihenfolge: `[pool_0, pool_0_companion_0, pool_1, pool_1_companion_0, ...]` (korrekte Abhängigkeitsreihenfolge für Fallback-Iteration).

### Full-Fit-Solver: Count-Step-Retry

In `TryPlaceCompositeLayout` wird pro Variante eine absteigende Retry-Schleife durchgeführt:

```
foreach variant in attemptOrder:
  slotsBase = SelectSlots(...)   ← statische Slots, einmal berechnet
  maxStep   = max über alle Pools von (countRange.Max - countRange.Min)

  for countStep = 0..maxStep:
    poolSlots  = ExpandPoolSlots(variant, roomSize, countStep, rng, log)
    slotsToPlace = slotsBase + poolSlots
    if TryPlaceCompositeLayoutVariant(...) → Erfolg → return true
    log: "failed ... retrying with N fewer pool slot(s)"
    continue

→ Variante erschöpft → nächste Variante
→ alle erschöpft → Fallback
```

Log-Zeile pro Attempt: `[LAYOUT] 'variant_id' step N: pool counts — pool_arm=K (range min–max)`.

### Fallback-Pfad

Wenn der Full-Fit-Solver alle Varianten erschöpft, läuft der Slot-by-Slot-Fallback. Dieser ruft jetzt **ebenfalls** `ExpandPoolSlots` auf (countStep=0 = maximale Anzahl):

```csharp
var fallbackPoolSlots = layoutVariant is not null
    ? ExpandPoolSlots(layoutVariant, roomSize, 0, rng, log)
    : [];
if (fallbackPoolSlots.Count > 0)
    slotsToPlace = [..slotsToPlace, ..fallbackPoolSlots.Select(s => (s, 1))];
```

Pool-Slots haben `RequiresSlot = anchorTarget` – der bestehende `[SKIP]`-Mechanismus in der Fallback-Schleife stellt sicher, dass Slots nur platziert werden, wenn ihr Anker in `anchorMap` ist. Da statische Slots zuerst iteriert werden und Pool-Slots am Ende angehängt sind, ist die Reihenfolge garantiert korrekt.

### Bekannte Einschränkungen

| Problem | Ursache |
|---------|---------|
| `Required=true` auf Pool-Slots → Full-Fit schlägt fehl wenn auch nur ein Pool-Slot keine gültige Position findet | Geometrische Enge (z.B. S-Küche 12 Zellen + Herd mit `blocksFrontCell`) → Count-Step-Retry + Fallback fangen das ab |
| Layer-Fehler: Counter-Required-Slots mit `requiredLayer: "Furniture"` finden keine Tiles | Counters sind auf `Furniture2` → Pool-Required-Slots für Counter müssen `requiredLayer: ""` haben (erbt dann `pool.requiredLayer = "Furniture2"`) |
| `disabled: true` Variante wird ignoriert | Gewünscht – in `SelectLayoutVariant` + `BuildLayoutAttemptOrder` herausgefiltert |

---

## Überblick: Ablauf pro Slot

```
FilterTiles()        → Kandidatenliste (Layer, Gruppe, Props, RoomType, Footprint)
SelectTile()         → ein Tile aus Kandidaten per Kategorie-Gewichtung
FindFreeCell()       → Ankerzelle + Orientierung + aufgelöste TileDefinition
  └─ Pool-Filter     → nur erlaubte Zellen je nach PlacementRules
  └─ ResolveVariantForCell()  → Wandrichtung + korrekte Orientierungsvariante
  └─ ComputeWallAnchor()      → verschiebt Anker von Rückseite in Raumrichtung
  └─ FitsFootprint()          → Footprint komplett im Raum + nicht belegt
  └─ FootprintTouchesCells()  → Türbereich frei halten
PlaceSlot()          → Footprint-Zellen als occupied markieren + PlacedFurnitureItem erzeugen
```

---

## FilterTiles

**Ziel:** Gibt alle für einen Slot passenden `TileDefinition`-Objekte zurück.

**Filter-Reihenfolge:**
1. `RequiredLayer` (z.B. `"Furniture"`) – leer = beliebig
2. `AllowedCategories` (Dictionary<group, weight>) – leer = beliebig
3. `RequiredProperties` – alle müssen `true` sein (`GetBoolProperty`)
4. `RoomTypes` – leer im Tile = belieibg; sonst mind. einer muss roomTypeName matchen
5. **Footprint-Filter** (Sonderfall VariantGroups):
   - Tiles **ohne** VariantGroup: exakter Größencheck `tW==fpW && tH==fpH` (oder gedreht wenn `CanRotate`)
   - Tiles **mit** VariantGroup: Gruppe ist erlaubt wenn **mind. eine Variante** der Gruppe die Größe erfüllt (validGroups-Vorberechnung). Dadurch werden alle Orientierungen einer Gruppe in den Pool aufgenommen – `ResolveVariantForCell` wählt die korrekte.

**Deduplizierung:** Pro VariantGroup nur **ein Repräsentant** im Pool. Der Generator sucht die tatsächliche Variante erst in `ResolveVariantForCell`.

---

## SelectTile

Wählt per **Kategorie-Gewichtung** ein Tile aus der Kandidatenliste:
- `AllowedCategories` leer → zufällig aus allen
- Gewichtetes Zufallszug auf Kategorie-Ebene → zufällig aus der gewählten Kategorie

---

## FindFreeCell

**Haupt-Suchschleife**: Iteriert über einen gefilterten, zufällig gemischten Pool von Raumzellen.

### Pool-Filter (Reihenfolge)

| Rule | Effekt |
|------|--------|
| `NearWall = true` | Nur Zellen, die selbst eine Wandzelle sind **ODER** deren Footprint eine Wandzelle berührt (`FootprintTouchesWall`) – auch für nicht-quadratische Footprints und CanRotate |
| `NearDoor = true` | Nur Türzellen |
| `NearWindow = true` | Nur Fensterzellen |
| `CornerOnly = true` | Nur Zellen mit ≥ 2 Wandrichtungen |
| `AllowOnPath = false` + `HasCollision` | Pfadzellen ausschließen (Laufweg frei halten) |
| `CenterRoom = true` | Sortierung nach Abstand zur Raummitte |

Danach: `Distinct()` + Shuffle (Fisher-Yates).

### Pro Zelle in der Schleife

1. **`ResolveVariantForCell()`** → `(resolvedTile, orient, wallDir)` oder `null` (→ `rejNoVariant++`)
2. **`ComputeWallAnchor(cell, wallDir, fpW, fpH)`** → `(anchorCol, anchorRow)` (nur wenn `NearWall=true`, sonst `cell` direkt)
3. **`FitsFootprint(anchorCol, anchorRow, fpW, fpH, roomCells, occupied)`** (→ `rejNoFit++`)
4. **Pfad-Schutz auf Footprint-Ebene**: `FootprintTouchesCells(anchorCol, anchorRow, fpW, fpH, pathCells)` wenn `!AllowOnPath && HasCollision` (→ `rejNoFit++`). Nötig weil der Pool-Filter nur die Ankerzelle selbst prüft – nach `ComputeWallAnchor` kann der verschobene Anker trotzdem Pfadzellen überdecken.
5. **`FootprintTouchesCells(anchorCol, anchorRow, fpW, fpH, doorCells)`** wenn nicht `NearDoor` (→ `rejDoor++`)
6. **Fensterschutz**: `IsHigh && FootprintTouchesCells(..., windowCells)` wenn nicht `NearWindow` (→ `rejWindow++`)
7. **`LootContainerReachable`**: Nur wenn `IsLootContainer`. Jede Footprint-Zelle braucht mind. eine freie Nachbarzelle (Moore, Reichweite 1) (→ `rejNoFit++`)
8. **`RoomRemainsConnected`**: Nur wenn `HasCollision`. BFS über alle begehbaren Zellen nach simulierter Platzierung – alle müssen zusammenhängend erreichbar sein (**4-Nachbarschaft**, da Bewegung in PZ rein orthogonal ist) (→ `rejConnectivity++`)
9. ✅ Return `(anchorCol, anchorRow, orient, resolvedTile, rejNoVariant, rejNoFit, rejDoor, rejWindow, rejConnectivity)`

---

## ResolveVariantForCell

**Aufgabe:** Bestimmt für eine Kandidatenzelle welche Tile-Variante in welcher Orientierung zu platzieren ist.

```
NearWall = false → Tile unverändert, wallDir = N (Dummy)
```

**Mit NearWall:**

1. **Wandrichtung ermitteln:**
   - Ankerzelle selbst: `cellWalls[cell]` (immer vorhanden nach korrigiertem Pool-Filter)
   - Sicherheitsnetz (sollte nicht vorkommen): `FootprintWallDirs` – wenn leer → `null` (rejNoVariant)

2. **Bevorzugte Wandrichtung wählen:**
   - `BackWall(baseTile.Orientation)` = erwartete Rückenwand des Basis-Tiles
   - Wenn diese in den gefundenen Wandrichtungen vorkommt → nehmen
   - Sonst: größten Enum-Wert nehmen (`OrderByDescending`)
   
   Direction-Enum: `N=0, S=1, E=2, W=3`

3. **`neededOrient`** = `WallToOrient(wallDir)`:
   ```
   N-Wand → Orient "S"  (Möbel schaut nach Süden, Rücken an Nordwand)
   S-Wand → Orient "N"
   E-Wand → Orient "W"
   W-Wand → Orient "E"
   ```

4. **`AllowedOrients`-Prüfung:** Wenn das Tile `allowedOrients` hat (z.B. `["E","S"]` für Bilder), muss `neededOrient` darin enthalten sein – sonst `null`.

5. **Variante suchen:**
   - BaseTile selbst passt (richtiger Orient + WallAlignment) → direkt zurückgeben
   - Sonst in `VariantGroup` suchen: alle Tiles mit gleicher VariantGroup und passendem Orient
   - Bestes Match: erfüllt zusätzlich `MatchesAlignment`
   - Keine Variante → `null`

### BackWall / WallToOrient

```csharp
BackWall:    S→N,  N→S,  W→E,  E→W
WallToOrient: N→S, S→N, E→W, W→E
```

### MatchesAlignment

| WallAlignment | N/S-Wand | E/W-Wand |
|---------------|----------|----------|
| `perpendicular` | fpH > fpW (hochkant) | fpW > fpH (querformat) |
| `parallel` | fpW > fpH (querformat) | fpH > fpW (hochkant) |
| `any` | immer true |  |

Quadratische Tiles (fpW == fpH): immer true.

---

## ComputeWallAnchor ← **Kern-Fix für NearWall**

**Problem ohne diesen Fix:** Die Wandzelle wurde als linke-obere-Ecke des Footprints verwendet.
Für eine Ostwand (z.B. col=6) würde ein 2×2-Footprint auf (6,x)+(7,x) expandieren – (7,x) liegt außerhalb des Raums.

**Lösung:** Wandzelle = **Rückseite** des Möbels. Anker in den Raum verschieben.

```csharp
N-Wand → (wallCell.col,           wallCell.row)          // Möbel expandiert nach unten
S-Wand → (wallCell.col,           wallCell.row - fpH + 1) // Möbel expandiert nach oben
W-Wand → (wallCell.col,           wallCell.row)          // Möbel expandiert nach rechts
E-Wand → (wallCell.col - fpW + 1, wallCell.row)          // Möbel expandiert nach links
```

**Beispiel:** E-Wand bei col=6, 2×2-Bett:
- `ComputeWallAnchor((6,3), E, 2, 2)` → Anker (5,3)
- Footprint: (5,3), (6,3), (5,4), (6,4) → alle im Raum ✓

---

## FootprintTouchesWall / FootprintWallDirs

**FootprintTouchesWall(col, row, fpW, fpH):**  
`true` wenn irgendeine Zelle im Footprint-Bereich in `cellWalls` vorkommt.  
→ Wird für den `NearWall`-Pool-Filter verwendet (damit Ankerzellen innenliegender Möbelteile erlaubt sind).

**FootprintWallDirs(col, row, fpW, fpH):**  
Gibt alle Wandrichtungen zurück, die im Footprint-Bereich vorkommen.  
→ Wird in `ResolveVariantForCell` verwendet wenn die Ankerzelle selbst keine Wand hat.

---

## FitsFootprint / FitsFootprintLoose

**FitsFootprint(col, row, fpW, fpH, roomCells, occupied):**  
Alle Zellen `(col+c, row+r)` müssen in `roomCells` sein UND nicht in `occupied`.

**FitsFootprintLoose(col, row, fpW, fpH, occupied):**  
Nur `occupied`-Check (kein roomCells-Check). Für Anchor-basierte Platzierung.

---

## Fallback-Kette

Falls `FindFreeCell` mit den primären `PlacementRules` keinen Platz findet:
```csharp
foreach fb in slot.FallbackRules:
    result = FindFreeCell(..., fbRules)
    if (result != null) → log "[FALLBACK N]" + platzieren
```

---

## blocksPlacement – occupied-Verwaltung

Nach erfolgreicher Platzierung werden die Footprint-Zellen bedingt in `occupied` eingetragen:

```csharp
if (slot.BlocksPlacement)
    occupied.Add((col + c, row + r));
```

| Wert | Effekt |
|------|--------|
| `true` (Standard) | Zellen blockieren weitere Platzierungen (Möbel, Bett, Schrank …) |
| `false` | Zellen bleiben frei → andere Slots können dieselbe Grid-Zelle nutzen (Layer-Überlagerung im Spiel) |

**Rugs:** `blocksPlacement: false` – Möbel können auf dem Teppich platziert werden (Rugs haben Priorität 0 und werden zuerst gelegt).  
**Nachttisch:** `blocksPlacement: true` – Zellen blockiert für normale Slots. Abhängige Slots (z.B. Lampe via `requiresSlot + AnchorRules`) nutzen die `excludeFromOccupied`-Ausnahme in `FitsFootprint` und können trotzdem darauf landen.

---

## Anchor-basierte Platzierung (AnchorRules)

Wenn ein Slot `AnchorRules` hat und das Anchor-Slot bereits platziert wurde:

```
anchorInfo    = anchorMap[rule.AnchorTarget]   // (col, row, fpW, fpH, orient) des Anker-Slots
anchorOrient  = orientRule
  (match | opposite | cwPerpendicular | ccwPerpendicular | facingAnchor | N/S/E/W | default)
finalTile     = VariantGroup-Suche nach anchorOrient (Dimensionen korrekt ableiten)
p             = ComputeAnchoredPosition() → (depCol, depRow)
anchorExclude = Zellen des Ankermöbels (wenn RequiresSlot gesetzt)
→ FitsFootprint(ac, ar, fpW, fpH, roomCells, occupied, anchorExclude)
```

### Anchor-Orientierungsregeln

| Regel | Mapping |
|------|---------|
| `match` | identisch zur Orientierung des Ankers |
| `opposite` | `N↔S`, `E↔W` |
| `cwPerpendicular` | `S→E`, `E→N`, `N→W`, `W→S` |
| `ccwPerpendicular` | `S→W`, `W→N`, `N→E`, `E→S` |
| `openSideFacing` | leitet Orientierung aus gewaehlter openSide ab: `N→S`, `S→N`, `E→W`, `W→E` |
| `facingAnchor` | aus Position + Anker-Footprint abgeleitet |
| `N/S/E/W` | fixe Orientierung |
| `NW/NE/SW/SE` | fixe diagonale Orientierung (für Eckstücke) |
| `cornerFromAnchor` | leitet NW/NE/SW/SE aus Anker-Orient + Position ab (siehe Tabelle unten) |

**occupied-Ausnahme für requiresSlot:**  
Wenn `slot.RequiresSlot` gesetzt ist, werden die Zellen des Ankermöbels in `anchorExclude` gesammelt und beim `FitsFootprint`-Check ausgeblendet.  
Dadurch kann z.B. eine Lampe (Position `"Center"`) auf dem Nachttisch landen,  
**ohne** dass `blocksPlacement` am Nachttisch deaktiviert werden muss.  
Stühle und andere Slots ohne `requiresSlot` prüfen weiterhin gegen das volle `occupied`-Set.

**anchorMap** wird nach jeder Platzierung befüllt mit Slot-ID und SlotGroupId.

### cornerFromAnchor – Diagonale Eckorientierung

`cornerFromAnchor` leitet eine diagonale Orientierung (`NW/NE/SW/SE`) aus der Kombination von **Anker-Orient** und **Position** ab. Gedacht für Küchen-Eckstücke (L-Shape/U-Shape), die je nach Raumecke eine andere Variante benötigen.

**Rückgabewert = Eckenposition** (= tile's `orientation`-Feld in tile-definitions.json).
Konvention in tile-definitions.json: `orientation` = welche Raumecke das Tile besetzt (NW = geht in NW-Ecke), `allowedOrients` = alternative Eckenposition (meist Gegenecke).
- NW-Ecke (Wände N+W) → zurückgegeben: `NW` → findet Tile mit orientation=NW (exact match)
- NE-Ecke (Wände N+E) → zurückgegeben: `NE`
- SW-Ecke (Wände S+W) → zurückgegeben: `SW`
- SE-Ecke (Wände S+E) → zurückgegeben: `SE`

| Anker-Orient | Position | Rückgabe |
|---|---|---|
| `S` | `rightOfAnchor` | `NW` |
| `S` | `leftOfAnchor` | `NE` |
| `N` | `rightOfAnchor` | `SE` |
| `N` | `leftOfAnchor` | `SW` |
| `E` | `rightOfAnchor` | `SW` |
| `E` | `leftOfAnchor` | `NW` |
| `W` | `rightOfAnchor` | `NE` |
| `W` | `leftOfAnchor` | `SE` |

**Verwendung im Slot-JSON:**
```json
{
  "anchorTarget": "slot_counter_main_2",
  "positions": ["rightOfAnchor"],
  "orient": "cornerFromAnchor"
}
```

`ResolveFinalTile` sucht dann in der VariantGroup nach einem Tile mit `orientation: "NW"` (exact match, Eckenposition). Eck-Tiles in `tile-definitions.json`: `orientation` = Eckenposition, `allowedOrients` = alternative Ecke (meist Gegenecke).

### ComputeAnchoredPosition-Werte

| Position | Berechnung |
|----------|-----------|
| HeadLeft | orient-abhängig: S→`(ac-depW, ar)`, N→`(ac+aw, ar+ah-depH)`, W→`(ac+aw-depW, ar-depH)`, E→`(ac, ar+ah)` |
| HeadRight | orient-abhängig: S→`(ac+aw, ar)`, N→`(ac-depW, ar+ah-depH)`, W→`(ac+aw-depW, ar+ah)`, E→`(ac, ar-depH)` |
| FootLeft | orient-abhängig: S→`(ac-depW, ar+ah-depH)`, N→`(ac+aw, ar)`, W→`(ac-depW, ar-depH)`, E→`(ac+aw-depW, ar+ah)` |
| FootRight | orient-abhängig: S→`(ac+aw, ar+ah-depH)`, N→`(ac-depW, ar)`, W→`(ac-depW, ar+ah)`, E→`(ac+aw-depW, ar-depH)` |
| Left | W/E-Anker: `(ac+(aw-depW)/2, ar-depH)` · N/S-Anker: `(ac-depW, ar+(ah-depH)/2)` |
| Right | W/E-Anker: `(ac+(aw-depW)/2, ar+ah)` · N/S-Anker: `(ac+aw, ar+(ah-depH)/2)` |
| Above | `(ac+(aw-depW)/2, ar-depH)` |
| Below | `(ac+(aw-depW)/2, ar+ah)` |
| Center | `(ac+(aw-depW)/2, ar+(ah-depH)/2)` |
| frontOfAnchor | relativ zu `anchorOrient`: `N→Above`, `S→Below`, `E→Right`, `W→Left` |
| behindAnchor | relativ zu `anchorOrient`: `N→Below`, `S→Above`, `E→Left`, `W→Right` |
| leftOfAnchor | relativ zu `anchorOrient`: `N→Left`, `S→Right`, `E→Above`, `W→Below` |
| rightOfAnchor | relativ zu `anchorOrient`: `N→Right`, `S→Left`, `E→Below`, `W→Above` |
| leftPerpendicular | links relativ zur Blickrichtung des Ankers: `N→W`, `E→N`, `S→E`, `W→S` |
| rightPerpendicular | rechts relativ zur Blickrichtung des Ankers: `N→E`, `E→S`, `S→W`, `W→N` |
| perpendicularSide | Legacy-Alias für `leftPerpendicular` |
| openSidePlacement | offene Seite: testet `Primary`, dann `Secondary` und nimmt die erste gueltige |

---

### openSidePlacement (generische Spezifikation)

`openSidePlacement` ist ein generischer Anchor-Positionsmodus fuer offene Seiten
(z. B. Dusche/U-Form, L-Shape-Ende, seitlicher Anbau an einem Hauptobjekt).

#### Zielverhalten

- Es wird nur **eine** Zielposition verwendet.
- Die Regel prueft zuerst die bevorzugte Seite (`Primary`), dann die Alternative (`Secondary`).
- Die erste gueltige Seite gewinnt.

#### Gueltigkeit pro Kandidatenseite

Eine Kandidatenseite ist nur gueltig, wenn:

1. Zielzelle/Fussabdruck im Raum liegt (`roomCells`).
2. `FitsFootprint(...)` besteht.
3. Slot-Regeln fuer Door/Window/Path bestehen.

#### PZ-Zellprojektion der Wandkante

Da PZ Wandkanten nur als `N`/`W` auf einer Zelle speichert, werden Zielseiten so auf
Zellen abgebildet:

| Zielseite | Zielzelle |
|----------|-----------|
| `W` | gleiche Zelle wie der Anchor |
| `N` | gleiche Zelle wie der Anchor |
| `E` | rechte Nachbarzelle |
| `S` | untere Nachbarzelle |

Beispiel: Anchor zeigt `S`, Mapping prueft `W` dann `E`.
`W` landet auf derselben Zelle (Westwand der Dusche), nicht auf der linken Nachbarzelle.

#### Mapping-Tabelle (Anchor-Orient -> Primary/Secondary)

| Anchor-Orient | Primary | Secondary |
|--------------|---------|-----------|
| `W` | `S` | `N` |
| `E` | `S` | `N` |
| `N` | `W` | `E` |
| `S` | `W` | `E` |

Interpretation:

- Bei horizontaler Orientierung (`E/W`) werden vertikale Seiten (`S/N`) getestet.
- Bei vertikaler Orientierung (`N/S`) werden horizontale Seiten (`W/E`) getestet.

#### Beispiel-JSON (copy/paste) fuer `room-types.json`

```json
{
  "id": "slot_wall_attachment",
  "label": "Open Side Attachment",
  "anchorRules": [
    {
      "anchorTarget": "slot_anchor",
      "positions": ["openSidePlacement"],
      "offsetAlongAnchor": 0,
      "orient": "openSideFacing"
    }
  ],
  "requiresSlot": "slot_anchor"
}
```

Hinweise zum Beispiel:
- `openSidePlacement` steuert die Position, `orient` weiterhin nur die Ausrichtung.
- Fuer "maximal 1 Wand"-Faelle wird genau ein Slot verwendet (statt zwei konkurrierender Slots).
- Das Mapping ist generisch und dadurch wiederverwendbar fuer andere Anchors.

## VariantGroup-System

**Ziel:** Mehrere TileDefinitions (N/S/E/W-Varianten) gehören logisch zusammen.

**Workflow:**
1. `FilterTiles`: alle Gruppen die mind. eine passende Variante haben → `validGroups`; Deduplizierung auf einen Repräsentant pro Gruppe
2. `SelectTile`: wählt ggf. den Repräsentanten (irgendeine Variante der Gruppe)
3. `ResolveVariantForCell`: sucht aus `allTiles` die Variante mit dem passenden Orient für die konkrete Wandzelle

**Konfiguration in tile-definitions.json:**
```json
{ "tileId": "..._014", "variantGroup": "bed_double_black_01", "orientation": "E" }
{ "tileId": "..._070", "variantGroup": "bed_double_black_01", "orientation": "W" }
{ "tileId": "..._126", "variantGroup": "bed_double_black_01", "orientation": "N" }
{ "tileId": "..._182", "variantGroup": "bed_double_black_01", "orientation": "S" }
```

---

## AllowedOrients

Feld `AllowedOrients: List<string>` in `TileDefinition.cs` / `allowedOrients: string[]` in `tiles.ts`.

- Leer = alle 4 Richtungen erlaubt
- Beispiel Bilder: `["E", "S"]` → nur an Ostwand (Orient="W") oder Südwand (Orient="N") platzierbar
- Prüfung in `ResolveVariantForCell` vor der Varianten-Suche

---

## Debug-Logs

| Log-Eintrag | Bedeutung |
|-------------|-----------|
| `[WARN] 'slot': no matching tiles (...)` | `FilterTiles` gibt 0 zurück |
| `[WARN] 'slot': no valid position for 'tile' ... candidates=N` | Alle Pool-Zellen abgelehnt |
| `[DEBUG] 'slot': pool tried, rejNoVariant=X rejNoFit=Y rejDoor=Z rejWindow=W rejConnectivity=C` | Ablehnungszähler der Schleife (nur bei Erfolg) |
| `[PLACED] 'slot': 'tile' orient 'O' at (c,r)` | Erfolgreich platziert |
| `[FALLBACK N]` | Primary fehlgeschlagen, Fallback N verwendet |

**Wichtige Felder im WARN:**
- `fp=W×H` – Footprint-Größe des zuletzt geprüften Tiles
- `variantGroup` – Gruppe des Tiles (leer = kein Variant-System)
- `roomCells=N free=N` – Gesamt- vs. freie Zellen
- `wallCells=N freeWall=N` – Wand- vs. freie Wandzellen
- `nearWall` / `wallAlignment` – aktive Placement Rules
- `candidates=N` – Anzahl Tiles nach FilterTiles

---

## Bekannte Einschränkungen / Fallstricke

| Problem | Ursache / Lösung |
|---------|-----------------|
| Möbel-Footprint expandiert über Raumgrenze | Typisch bei Ost-/Südwand ohne `ComputeWallAnchor` → war der Haupt-Bug, jetzt behoben |
| Alle Zellen `rejNoFit` obwohl Platz da | `NearWall`-Pool enthält Wandzellen, aber ohne Anchor-Offset passt Footprint nicht → `ComputeWallAnchor` löst das |
| Möbel in Raummitte trotz `NearWall=true` | Pool-Filter lässt innenliegende Zellen zu; nach Anchor-Verschiebung + anderer Variante fehlt Wandkontakt → Post-Anchor-Wandcheck (`FootprintTouchesWall`) lehnt ab |
| VariantGroup-Tile zu groß für Slot | Nur eine Orientierung passt → `validGroups`-Vorberechnung auf Gruppenebene, nicht auf Tile-Ebene |
| Möbel auf Laufweg | `HasCollision=true` + Pfadzellen bekannt → Footprint-Pfad-Check nach ComputeWallAnchor filtert auch verschobene Anker |
| Türbereich blockiert | `FootprintTouchesCells` prüft auch den verschobenen Anchor → `rejDoor` |
| Hohe Möbel vor Fenster | `IsHigh=true` + `windowCells` → `rejWindow` |
| WallAlignment-Prüfung wirkungslos | Kein Fallback `?? variants[0]` in `ResolveVariantForCell` – kein Match = `null` = `rejNoVariant` |
| Möbel isoliert Raumbereich | `HasCollision=true` + BFS nach simulierter Platzierung → `rejConnectivity`; verhindert dass Ecken oder Ausbuchtungen eines nicht-rechteckigen Raums abgeschnitten werden |
| Loot-Container nicht greifbar | `IsLootContainer=true` + Moore-Nachbarschafts-Check → `rejNoFit`; ergänzt `RoomRemainsConnected` für den Greifbarkeits-Edge-Case |
| Stuhl/Möbel landet auf Nachttisch | `blocksPlacement: false` am Ankermöbel ließ beliebige Slots überlappen → Lösung: `blocksPlacement: true` am Ankermöbel + `excludeFromOccupied`-Ausnahme in `FitsFootprint` für Slots mit `requiresSlot` |

---

## PathStyle – Laufweg-Stil pro Raumtyp

Konfiguriert in `RoomTypeConfig.pathStyle` (Backend `RoomTypeConfig.cs`, Frontend `roomTypes.ts`).

| Wert | A*-Kosten | Jitter | Typischer Einsatz |
|------|-----------|--------|-------------------|
| `"wall"` (Standard) | wandnah günstig (`open=1.0, wallAdj=0.4, corner=0.3`) | 0.15 | Schlafzimmer, Küche, Bad |
| `"center"` | mitte günstig (`open=0.4, wallAdj=1.2, corner=1.5`) | 0.15 | Wohnzimmer, Halle |
| `"random"` | alle gleich (`open=1.0, wallAdj=1.0, corner=1.0`) | 0.80 | Lager, Garage |

**Ablauf in `FurnishingGeneratorService.Generate`:**
- Pfad wird beim TBX-Upload immer mit `"wall"` vorberechnet.
- Wenn `config.PathStyle != "wall"`, ruft der Generator **vor der Möblierung** `_pathfinder.ComputeRoomPath(..., pathStyle)` auf und überschreibt den Pfad in `floor.PathsByRoom`.
- Der überschriebene Pfad gilt dann für alle folgenden `AllowOnPath=false`-Checks dieses Raums.

---

## Debug-Zähler – Bedeutung der `[DEBUG] pool tried`-Felder

Jede erfolgreiche Platzierung gibt eine Zeile aus:
```
[DEBUG] 'slot_id': pool tried, rejNoVariant=0 rejNoFit=0 rejDoor=0 rejWindow=0 rejConnectivity=0
```

Diese Zähler summieren alle **abgelehnten Kandidaten** während der Suchschleife in `FindFreeCell` (und ggf. FallbackRules). Sie helfen zu verstehen, warum bestimmte Positionen nicht funktionierten.

| Zähler | Bedeutung | Typische Ursache wenn hoch |
|--------|-----------|---------------------------|
| `rejNoVariant` | Keine passende Tile-Variante für diese Wandrichtung gefunden | Tile hat `allowedOrients` die nicht zur Wandrichtung passen; oder `VariantGroup` hat keine Variante für diesen Orient + WallAlignment |
| `rejNoFit` | Footprint passt nicht in den Raum / Zelle belegt | Zu wenig Platz, Zellen bereits durch andere Möbel belegt (`occupied`), Laufweg (`pathCells`) wird berührt, oder Loot-Container hat keine freie Nachbarzelle |
| `rejDoor` | Footprint überdeckt eine Türzelle | Möbel würde Türdurchgang blockieren; nur Slots mit `nearDoor=true` dürfen Türzellen berühren |
| `rejWindow` | Hohes Möbel vor einem Fenster | `isHigh=true` + Footprint berührt Fensterzelle; nur Slots mit `nearWindow=true` sind davon ausgenommen |
| `rejConnectivity` | Platzierung würde Raumbereich isolieren | Nach simulierter Platzierung wären nicht mehr alle Raumzellen per BFS erreichbar (z.B. Möbel blockiert Ecke oder Ausbuchtung) |

**Hinweis:** Die Zähler erscheinen nur bei **erfolgreicher** Platzierung. Bei Misserfolg erscheint stattdessen eine `[WARN]`-Zeile mit denselben Werten plus weiteren Infos (`candidates=N`, `roomCells=N`, etc.).

---

## Dummy-Slot-Muster: optionale Aufsätze / zufällige Nicht-Platzierung

**Problem:** Bei `min=0, max=1` und `density=100%` wird ein optionaler Slot **immer** platziert
(`rng.NextDouble() < 1.0` ist immer `true`). Gestapelte Objekte (z.B. Kiste auf Kiste)
erscheinen dann bei jeder Generierung — ohne Variation.

**Lösung:** Den Aufsatz-Slot in eine `slotGroupId` packen und einen **Dummy-Slot** als
Konkurrenten hinzufügen. Die SlotGroup wählt genau einen Gewinner — der Dummy tut nichts
(alle `countBySize.max = 0`).

### Beispiel: Holzkiste mit optionalem Aufsatz (50/50)

```json
{
  "id": "slot_wooden_crate_mid",
  "label": "Wooden Crate Mid",
  "slotGroupId": "grp_wooden_crate_top",
  "groupWeight": 5,
  "requiresSlot": "slot_wooden_crate",
  "requiredLayer": "Furniture2",
  "countBySize": { "S": {"min":0,"max":1}, "M": {"min":0,"max":2}, ... }
},
{
  "id": "slot_wooden_crate_mid_skip",
  "label": "Wooden Crate Mid (skip)",
  "slotGroupId": "grp_wooden_crate_top",
  "groupWeight": 5,
  "requiresSlot": "",
  "countBySize": { "XS": {"min":0,"max":0}, "S": {"min":0,"max":0}, "M": {"min":0,"max":0}, "L": {"min":0,"max":0}, "XL": {"min":0,"max":0} }
}
```

→ 50 % Chance Aufsatz, 50 % Chance keine zweite Kiste — unabhängig von der Raum-Density.

### Regeln

| Feld | Aufsatz-Slot | Dummy-Slot |
|------|-------------|------------|
| `slotGroupId` | gleiche Gruppe | gleiche Gruppe |
| `groupWeight` | gewünschtes Gewicht (> 0) | gewünschtes Gewicht (> 0) |
| `requiresSlot` | Basis-Slot-ID | leer (`""`) — Dummy hat keine Abhängigkeit |
| `countBySize` | normale Werte | alle `max: 0` |
| `requiredLayer` | korrekt setzen | egal (wird nie platziert) |

**Wichtig:** Beide `groupWeight`-Werte müssen `> 0` sein. Bei `groupWeight: 0` greift
der Fallback `totalW = variants.Count` und alle Slots bekommen gleiches Gewicht —
das funktioniert zwar auch, ist aber schwerer zu steuern.

Das Gewichtsverhältnis steuert die Wahrscheinlichkeit **direkt und unabhängig von der
globalen Density** — ideal für optionale Dekorationen, Aufsätze und Stapel-Varianten.




















