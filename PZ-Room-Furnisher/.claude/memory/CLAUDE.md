# PZ Room Furnisher – Claude Code Kontext

## Projektübersicht

**PZ Room Furnisher** ist ein Web-Tool für *Project Zomboid*, das TBX-Gebäudedateien einliest,
visualisiert und automatisch mit Möbeln bestückt. Ergebnis wird als neue TBX-Datei exportiert.

- **Backend**: .NET 10 / ASP.NET Core Web-API (`/backend`)
- **Frontend**: React + TypeScript + Vite (`/frontend`)

---

## Projekt starten

```bash
# Backend (aus /backend):
dotnet run

# Frontend (aus /frontend):
npm run dev
```

**Ports** (anpassen falls abweichend):
- Backend API: `https://localhost:5001`
- Frontend: `http://localhost:5173`

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

**Controller**: `BuildingController`, `FurnishController`, `RoomTypeController`, `TileLibraryController`, `SettingsController`

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

## Datenmodelle

### TileDefinition – 7 bool-Eigenschaften (Single Source of Truth in `tiles.ts`)
```typescript
export const TILE_PROPERTIES = [
  'isHigh', 'isLow', 'isWallMounted', 'hasSurface', 'hasCollision', 'canStack', 'isTableTop'
] as const;
```
Identische Felder in `TileDefinition.cs`. `REQUIRED_PROPERTIES` in `roomTypes.ts` muss dieselben Keys verwenden.

### AnchorRules
```typescript
interface AnchorRule {
  anchorTarget: string;        // Slot-ID ODER slotGroupId
  positions: AnchorPosition[]; // mehrere = OR (Generator wählt eine)
}
// AnchorPosition-Werte:
// HeadLeft, HeadRight, FootLeft, FootRight, Left, Right, Above, Below, Center
```
Migration: Alte `anchorSlotId`/`anchorPosition`-Daten werden beim Laden automatisch konvertiert.

Normalisierung nach Laden/Speichern:
```typescript
slots: config.slots.map(s => ({ ...s, anchorRules: s.anchorRules ?? [] }))
```

### LayoutVariants
```typescript
interface LayoutVariant {
  id: string;
  label: string;
  weight: number;
  slotIds: string[]; // aktive Slots dieser Variante
}
```
Generator wählt pro Raum eine Variante nach Gewicht und filtert die Slot-Liste vor der normalen Platzierung.

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

---

## Wichtige Konventionen & Fallstricke

| Thema | Regel |
|-------|-------|
| React Hook-Reihenfolge | `useState` VOR `useMemo` wenn State darin verwendet wird (TDZ-Fehler) |
| Normalisierung | Nach Laden/Speichern: `anchorRules: s.anchorRules ?? []` |
| knownCategories | Via `getCategories()` aus `settings.json` (18 Einträge); für `allGroups` useMemo in TileBrowser + FurnitureBrowser |
| TILE_PROPERTIES | Single Source of Truth in `tiles.ts`; `REQUIRED_PROPERTIES` in `roomTypes.ts` muss dieselben Keys verwenden |
| Raumtyp-Matching | Immer `InternalName` (nicht `Name`) für den Lookup verwenden |
| CSS-Kommentare | Nur `/* */`, keine `//` |
| Helferfunktionen | Vor der Komponenten-Funktion definieren |
| TypeScript | Immer TypeScript, kein JavaScript |

---

## Furnishing-Generator (Backend)

### Ablauf `FurnishingGeneratorService.Generate()`
1. Pro `RoomSelection`: Floor + Room suchen
2. `InternalName` → RoomTypeConfig-Key (case-insensitive)
3. Raumzellen aus `floor.RoomGrid` extrahieren → Größe klassifizieren
4. Wand- / Tür- / Fenster-Zellen berechnen
5. **Slots auswählen** (`SelectSlots`): Gruppen-Slots gewichtet, Pflicht-Slots zuerst, dann optionale nach Priorität
6. **Slot platzieren** (`PlaceSlot`): Tiles filtern, AnchorRules auflösen, Footprint gegen freie Zellen prüfen
7. `anchorMap` mit Slot-ID und slotGroupId befüllen

### Placement Rules
`NearWall`, `NearDoor`, `NearWindow`, `CenterRoom`, `CornerOnly`

---

## Wichtige Dateipfade

```
PZ-Room-Furnisher/
  backend/
    Services/
      TbxParserService.cs
      TbxExportService.cs
      FurnishingGeneratorService.cs   ← Kern (InternalName-Matching!)
      RoomTypeConfigService.cs
      TileConfigService.cs
    Models/
      Building.cs / Floor.cs / Room.cs
      FloorObject.cs                  ← OriginalType-Feld
      RoomTypeConfig.cs               ← AnchorRule, Slot, CountBySize
      TileDefinition.cs               ← 7 bool-Eigenschaften
    Data/
      settings.json
      room-types.json
      tile-definitions.json
  frontend/src/
    types/
      building.ts
      tiles.ts                        ← TILE_PROPERTIES (7 Keys)
      roomTypes.ts                    ← RoomTypeSlot, AnchorRule, REQUIRED_PROPERTIES
    api/
      buildingApi.ts / furnishApi.ts / roomTypesApi.ts / settingsApi.ts / tilesApi.ts
    components/
      FurnishPanel/FurnishPanel.tsx
      RoomTypeEditor/RoomTypeEditor.tsx
      TileBrowser/TileBrowser.tsx
      FurnitureBrowser/FurnitureBrowser.tsx
      GridRenderer.tsx
    App.tsx
```

---

## Arbeitsanweisungen für Claude Code

- **Vor Änderungen** an `FurnishingGeneratorService.cs` immer zuerst die bestehende Logik vollständig lesen
- **Frag nach**, bevor du Dateien löschst oder umbenennst
- **Kein `sudo`** bei npm-Befehlen
- Bei Unklarheiten zum Raumtyp-Matching: immer `InternalName` verwenden, nie `Name`
- Änderungen an `TILE_PROPERTIES` müssen in `tiles.ts` UND `TileDefinition.cs` synchron erfolgen
