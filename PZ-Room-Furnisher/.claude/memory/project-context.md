# PZ Room Furnisher – Projekt-Kontext

## Projektübersicht

**PZ Room Furnisher** ist ein Web-Tool für *Project Zomboid*, das aus zwei Teilen besteht:

- **Backend**: .NET 10 / ASP.NET Core Web-API (`/backend`)
- **Frontend**: React + TypeScript + Vite (`/frontend`)

Ziel: TBX-Gebäudedateien (Project Zomboid Building Editor Format) einlesen, visualisieren und
automatisch mit Möbeln bestücken. Das Ergebnis wird als neue TBX-Datei exportiert, die man im
PZ Building Editor öffnen und prüfen kann.

---

## Architektur

### Backend (`/backend`)
| Datei | Aufgabe |
|-------|---------|
| `TbxParserService.cs` | TBX-XML → `Building`-Objekt, speichert `OriginalType` pro `FloorObject` |
| `TbxExportService.cs` | `Building` + `PlacedFurnitureItem[]` → TBX-XML (Round-Trip-sicher) |
| `FurnishingGeneratorService.cs` | Kern-Algorithmus: RoomTypeConfig → Möbelplatzierung |
| `RoomTypeConfigService.cs` | Liest/speichert `room-types.json` |
| `TileConfigService.cs` | Liest/speichert `tile-definitions.json` |
| `SettingsService.cs` | Liest/speichert `settings.json` (knownCategories, tilesPath) |

**Controller**: `BuildingController`, `FurnishController`, `RoomTypeController`,
`TileLibraryController`, `SettingsController`

**Datenhaltung** in `/Data/`:
- `settings.json` → `knownCategories` (18 Gruppen), `tilesPath`
- `room-types.json` → RoomTypeConfig-Definitionen
- `tile-definitions.json` → gespeicherte Tile-Konfigurationen

### Frontend (`/frontend/src`)
| Komponente | Aufgabe |
|------------|---------|
| `App.tsx` | Root-State: `building`, `fileName`, `placements`, Tab-Steuerung |
| `GridRenderer` | Gebäude-Raster + platzierte Möbel als Punkte |
| `FurnishPanel` | Möblierung generieren + TBX exportieren |
| `TileBrowser` | Sprite-Auswahl aus PZ-Tilesets, Tile-Konfiguration |
| `FurnitureBrowser` | Möbelvorlagen durchsuchen |
| `RoomTypeEditor` | Raumtyp-Slots konfigurieren (Akkordion) |
| `SettingsEditor` | App-Einstellungen |
| `FileUpload` | TBX hochladen (Drag & Drop) |

---

## Datenmodelle

### TileDefinition – 7 bool-Eigenschaften (Single Source of Truth in `tiles.ts`)
```typescript
export const TILE_PROPERTIES = [
  'isHigh', 'isLow', 'isWallMounted', 'hasSurface', 'hasCollision', 'canStack', 'isTableTop'
] as const;
```
Identische Felder in `TileDefinition.cs`. Auch `REQUIRED_PROPERTIES` in `roomTypes.ts`
muss diese Keys verwenden (für Pillen im RoomTypeEditor).

### AnchorRules (ersetzt `anchorSlotId` + `anchorPosition`)
```typescript
interface AnchorRule {
  anchorTarget: string;        // Slot-ID ODER slotGroupId
  positions: AnchorPosition[]; // mehrere = OR (Generator wählt eine)
}
// RoomTypeSlot:
anchorRules: AnchorRule[];     // leer = freie Platzierung
```
**AnchorPosition-Werte**: `HeadLeft`, `HeadRight`, `FootLeft`, `FootRight`,
`Left`, `Right`, `Above`, `Below`, `Center`

**Migration**: Alte `anchorSlotId`/`anchorPosition`-Daten werden beim Laden automatisch
in eine `AnchorRule` konvertiert.

**Normalisierung nach Laden/Speichern**:
```typescript
slots: config.slots.map(s => ({ ...s, anchorRules: s.anchorRules ?? [] }))
```

### LayoutVariants (neue Shape-Ebene)
```typescript
interface LayoutVariant {
  id: string;
  label: string;
  weight: number;
  slotIds: string[]; // aktive Slots dieser Variante
}
```
**Zweck:** Eine Layout-Variante aktiviert einen Satz von Slots gemeinsam (z.B. lineare Küche, L-Sofa, U-Theke).
Der Generator wählt pro Raum eine Variante nach Gewicht und filtert die Slot-Liste vor der normalen Platzierung.

### RoomSize (Klassifizierung nach Zellanzahl)
| Key | Zellen |
|-----|--------|
| XS  | ≤ 4    |
| S   | ≤ 12   |
| M   | ≤ 25   |
| L   | ≤ 50   |
| XL  | > 50   |

### PlacedFurnitureItem
```typescript
interface PlacedFurnitureItem {
  floorIndex: number;
  col: number; row: number;
  tileId: string;
  layer: string;
  orient: string;  // N/S/E/W
}
```

### FloorObject (erweitert um Round-Trip-Export)
```typescript
interface FloorObject {
  type: ObjectType;
  originalType: string;  // Raw-String aus TBX z.B. "door", "furniture"
  x: number; y: number;
  dir: DirectionType;
  tile: string;
}
```

---

## Raumtyp-Matching

**Wichtig**: Der Typ-Lookup verwendet `room.InternalName` (nicht `room.Name`).
- TBX: `<room InternalName="bedroom" Name="Bedroom"/>`
- Lookup mit `"bedroom"` (klein) → matcht direkt auf RoomTypeConfig-Key
- In der App sind alle Raumtyp-Keys **kleingeschrieben**
- Override möglich: Im `FurnishPanel` manuellen Raumtyp eingeben

---

## Furnishing-Generator (Backend)

### Ablauf `FurnishingGeneratorService.Generate()`
1. Pro `RoomSelection`: Floor + Room suchen
2. `InternalName` → RoomTypeConfig-Key (case-insensitive)
3. Raumzellen aus `floor.RoomGrid` extrahieren → Größe klassifizieren
4. Wand- / Tür- / Fenster-Zellen berechnen
5. **Slots auswählen** (`SelectSlots`):
   - Gruppen-Slots: gewichtete Zufallswahl per `GroupWeight`
   - Pflicht-Slots zuerst, dann optionale nach Priorität
   - Anzahl per `CountBySize[roomSize].Min/Max`
6. **Slot platzieren** (`PlaceSlot`):
   - Tiles filtern: `RequiredLayer`, `AllowedCategories`, `RequiredProperties`
   - Tile per Kategorie-Gewichtung wählen
   - AnchorRules auflösen → `anchorMap` für Folge-Slots
   - Footprint (`TileLayout`-Dimensionen) gegen freie Zellen prüfen
    - Falls `layoutVariants` vorhanden sind: zuerst Variant-Auswahl, dann nur die zugehörigen Slots platzieren
7. `anchorMap` mit Slot-ID und slotGroupId befüllen

### Placement Rules
- `NearWall`, `NearDoor`, `NearWindow`, `CenterRoom`, `CornerOnly`
- Wandorientierung: Tile-Orientation `S` → bevorzugt Zellen mit Nordwand

---

## TBX Export

**Endpoint**: `POST /api/furnish/export-tbx`

```
Building + PlacedFurnitureItem[] + OriginalFileName
→ TBX-XML → Download als "<original>_furnished.tbx"
```

Neue Möbel werden als `<object type="furniture" .../>` in den jeweiligen `<floor>`-Block geschrieben.
Original-Objekte (Doors/Windows/Stairs) über `FloorObject.OriginalType` round-trip-sicher.

---

## FurnishPanel UI

**Raumliste** pro Eintrag:
- Farbkästchen (TBX `"R G B"` → CSS `rgb(R,G,B)`)
- Anzeigename (`room.name`) + InternalName kursiv/gedämpft
- Größen-Badge (XS–XL)
- Etagen-Badge bei Mehrstockgebäuden (`E0`, `E1`, …)
- ⚠-Icon wenn kein passender Raumtyp konfiguriert

**Weitere Elemente**:
- Override-Input mit Autocomplete (alle bekannten Raumtypen)
- Seed-Eingabe + 🎲-Würfelbutton
- "Möblieren"-Button → `POST /api/furnish/generate`
- Nach Generierung: Tile-Anzahl + Log-Akkordion
- "Möblierte TBX exportieren"-Button

---

## RoomTypeEditor Features

- **Akkordion-Slots**: Nach Speichern alle zugeklappt; Header zeigt ID, Label, Badges
- **Header-Badges**: Pflicht/Optional · B×H · Varianten-Gruppe · Prio (`P0`…) bei optionalen Slots ohne Gruppe
- **Lösch-Bestätigung**: `window.confirm()` vor dem Entfernen
- **AnchorRules-UI**: Anker-Textfeld (Datalist: Slot-IDs + Gruppen-IDs) + Positions-Chips (Mehrfachauswahl = OR)
- **Layer = Pflichtfeld**: kein "Beliebig", roter Rand wenn leer, Speicher-Validierung
- **Weight-Anzeige**: Label zeigt `(1–10)`, Tooltip beginnt mit „Wertebereich: 1–10"

---

## Wichtige Konventionen & Fallstricke

| Thema | Regel |
|-------|-------|
| React Hook-Reihenfolge | `useState` VOR `useMemo` wenn State darin verwendet wird (TDZ-Fehler) |
| Normalisierung | Nach Laden/Speichern: `anchorRules: s.anchorRules ?? []` |
| knownCategories | Via `getCategories()` aus `settings.json` (18 Einträge); für `allGroups` useMemo in TileBrowser + FurnitureBrowser |
| TILE_PROPERTIES | Single Source of Truth in `tiles.ts`; `REQUIRED_PROPERTIES` in `roomTypes.ts` muss dieselben Keys verwenden |
| Raumtyp-Matching | Immer `InternalName`, nie `Name` |
| CSS-Kommentare | Nur `/* */`, keine `//` |
| Helferfunktionen | Vor der Komponenten-Funktion definieren (kein Hoisting bei `const`/`function` im Modul-Scope beachten) |

---

## API-Endpunkte

| Methode | URL | Beschreibung |
|---------|-----|--------------|
| POST | `/api/building/upload` | TBX hochladen → Building-Objekt |
| GET | `/api/roomtype` | Alle RoomTypeConfigs |
| PUT | `/api/roomtype/{id}` | RoomTypeConfig speichern |
| GET | `/api/tilelibrary` | Alle TileDefinitions |
| GET | `/api/settings` | Einstellungen (inkl. knownCategories) |
| POST | `/api/furnish/generate` | Möblierung generieren → FurnishResult |
| POST | `/api/furnish/export-tbx` | Möblierte TBX exportieren → Download |

---

## Wichtige Dateipfade

```
PZ-Room-Furnisher/
  backend/
    Services/
      TbxParserService.cs           ← OriginalType speichern
      TbxExportService.cs           ← TBX mit Furniture schreiben
      FurnishingGeneratorService.cs ← Kern (InternalName-Matching!)
      RoomTypeConfigService.cs
      TileConfigService.cs
    Models/
      Building.cs / Floor.cs / Room.cs
      FloorObject.cs                ← OriginalType-Feld
      RoomTypeConfig.cs             ← AnchorRule, Slot, CountBySize
      TileDefinition.cs             ← 7 bool-Eigenschaften
    Data/
      settings.json                 ← knownCategories, tilesPath
      room-types.json
      tile-definitions.json
  frontend/src/
    types/
      building.ts                   ← Building, PlacedFurnitureItem, FloorObject
      tiles.ts                      ← TILE_PROPERTIES (7 Keys), Labels DE/EN
      roomTypes.ts                  ← RoomTypeSlot, AnchorRule, REQUIRED_PROPERTIES
    api/
      buildingApi.ts                ← uploadTbx
      furnishApi.ts                 ← generateFurnishing, exportTbx
      roomTypesApi.ts               ← getRoomTypes
      settingsApi.ts                ← getCategories, getRoomTypeNames
      tilesApi.ts                   ← getTiles
    components/
      FurnishPanel/FurnishPanel.tsx ← komplette Möblierungs-UI
      RoomTypeEditor/RoomTypeEditor.tsx ← Slot-Editor mit Akkordion
      TileBrowser/TileBrowser.tsx
      FurnitureBrowser/FurnitureBrowser.tsx
      GridRenderer.tsx              ← Grid + furniturePlacements-Punkte
    App.tsx                         ← building, fileName, placements State
  Memory/
    project-context.md              ← diese Datei (in .gitignore)
```

