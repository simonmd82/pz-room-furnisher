**Language:** English | [Deutsch](README.de.md)

# PZ Room Furnisher

A tool to support Project Zomboid mod and map developers.
AI was used to create this app. If you don't like that, don't use it. 

---

## Table of Contents

- [Running the App](#running-the-app)
- [Running from Source (Developers)](#running-from-source-developers)
- [Usage: Buildings & Settings](#usage-buildings--settings)
  - [🏠 Building Tab](#-building-tab)
  - [⚙ Settings](#-settings)
- [Rooms & Furniture Settings](#rooms--furniture-settings)

---

## Running the App

No installation of .NET, Node, or anything else required — just download and run.

1. Go to the [Releases page](https://github.com/simonmd82/pz-room-furnisher/releases) and download the zip for your platform:
   - **Windows** – `PzRoomFurnisher-win-x64.zip`
   - **Linux** – `PzRoomFurnisher-linux-x64.zip`
2. Extract the zip.
3. **Windows** – double-click `PzRoomFurnisher.exe`. A console window opens and your browser opens automatically to the app.
4. **Linux** – in a terminal, in the extracted folder:
   ```bash
   chmod +x PzRoomFurnisher
   ./PzRoomFurnisher
   ```
   Your default browser should open automatically; if it doesn't, open `http://localhost:5000` manually.
5. To stop the app, close the console window (Windows) or press Ctrl+C in the terminal (Linux).

Your settings and configuration are saved next to the executable, in the `Data/` folder.

---

## Running from Source (Developers)

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

The backend runs by default on `http://localhost:5000`.

### Frontend

```powershell
cd frontend
npm install
npm run dev
```

The frontend runs by default on `http://localhost:5173`.

Alternatively, use the included scripts:

```powershell
.\run-frontend.ps1   # or run-frontend.cmd
```

---

## Usage: Buildings & Settings

### 🏠 Building Tab

The entry point of the application. Here you load and visualize a **Project Zomboid `.tbx` building file**.
Currently it can only furnish residential buildings. It uses Vanilla furniture by default, Melos and Simon_MD tiles can be enabled as well (see [Tile sets](#tile-sets)).

**What it can do:**

- **`.tbx` upload** – Parses the PZ Building Editor's building format (up to 10 MB).
- **Building info** – Shows dimensions (width × height), floor count, and total/per-floor room count.
- **Floor navigation** – Switch between all existing floors.
- **Grid renderer** – Visualizes the room grid as a colored tile grid with an SVG overlay.
  - Doors (orange) and windows (cyan) are drawn as bars on the walls.
  - Stairs are shown striped, the entry point marked with an ✕.
  - Tooltip per cell with room name, door/window info, and coordinates.
- **Grid and ISO view** – Switch above the building between the top-down grid and an isometric view like in Project Zomboid. The ISO view is view-only and needs the PZ Tiles folder set in Settings. Walls, doors, and windows can be shown at full height or as low stubs.
- **Zoom & pan** – Zoom buttons (−, %, +, Fit) or Ctrl + mouse wheel at the cursor. Drag to pan with the middle mouse button, or with the left mouse button anywhere except on furniture.
- **Move furniture** – After furnishing, placed furniture can be dragged to another spot (grid view only).
- **Room selection** – Single click or Ctrl+click (multi-select) to highlight / hide rooms.
- **A\* pathfinding** – Automatically calculates the shortest path between all door waypoints for every room on upload (with a small random jitter for visual variation).
  - Stair cells are excluded from routing; only the entry point is passable.
  - Cost gradient: open floor > cells near walls > corners.
- **Show paths** – Toggle to show/hide the calculated paths as colored dots in the grid.
- **Regenerate path** – Clicking 🔄 in a room legend entry recalculates that single room's path with a new random seed (no reload needed).

**Preparing the TBX file**

Create a residential building in BuildEd, with doors, windows, open walls, and save it as a `.tbx` file.
Leave the building unfurnished.

**How to use it:**

Drag the TBX file into the drop zone in the Building tab. The building becomes visible and can be edited.
Familiarize yourself with the legend above the building UI.
In the left column you can either select all rooms of a type, or select individual rooms to be furnished.
Under "Furniture config sources" choose which tile sets to use.
Use the sliders below the room list to set how densely furnished each selection should be. Each room then gets its own percentage density, based on your selection.
If every room should be furnished equally, check the checkbox above the button.
To furnish all rooms at maximum density, set both sliders to 100%.
Once you're happy with your selection, click the button and wait for the algorithm to finish. Depending on the building's size, this can take 1-2 minutes.
For small buildings this only takes a few seconds.
A progress dialog shows the rooms as they are furnished. "Stop" ends the run after the current room, and rooms already done are kept.
Afterwards you can review the result, and if you're happy with it, export it with the "TBX Export" button as a new TBX file, then reopen it in TileEd.
All furniture is placed in "Tile mode".

**Currently supported room types:**
- `bathroom`
- `bedroom`
- `closet`
- `diningroom`
- `kitchen`
- `laundry`
- `livingroom`
- `office`
- `garagestorage`
- `hall`

#### Tile sets

| Set | Default | Status |
|---|---|---|
| Vanilla | on | Base game furniture |
| Melos | off | Included, not 100% complete yet |
| Simon_MD | off | Included, not 100% complete yet |

Enable or disable a set under "Furniture config sources" in the Building tab. Only enabled sets are used for furnishing.
Melos and Simon_MD are not fully configured yet, so some of their furniture won't be placed. An exported building that uses them also needs those tile packs in your tools and game.

---

### ⚙ Settings

Global lists used by the other tabs.

**What it can do:**

- **Known room type names** – Central registry of all room type identifiers (used in the Tile Browser and Room Type Editor).
- **Known categories** – Central registry of all tile categories (offered as a category selection in the Room Type Editor).
- Entries can be added and removed (with a confirmation dialog).

---

## Rooms & Furniture Settings

These tabs are for configuring the automatic furnishing generator and are normally hidden behind an advanced-mode toggle.

### 🖼 Tile Browser

Tool for capturing and configuring **sprite tiles** from the PZ texture folders.

**What it can do:**

- **Path configuration** – Set the path to the game's `media/textures` folder. Saved persistently.
- **Directory browser** – Graphical file browser (navigates the filesystem through the backend – drives, folders).
- **Sheet list** – Lists all `.png` sprite sheets in the configured folder, with a search filter.
  - Shows a `defined / total` badge per sheet.
- **Sheet viewer** – Renders the full sprite sheet with zoom (0.5× / 1× / 1.5× / 2×).
  - Already-defined sprites are highlighted.
  - The selected sprite is marked.
  - When layout-assignment mode is active, a hint bar shows the active cell.
- **Tile configuration** – Clicking a sprite opens the configuration panel:
  - **Label** – Display name
  - **Group** – Category (predefined + custom; pick via chip or type a new one)
  - **Orientation** – N / S / E / W or any
  - **Height** – low / high (multi-select)
  - **Layer** – Furniture, Wallfurniture, FloorOverlay, … (10 layers)
  - **Flags** – `blocksPathing`, `wallMounted`, `canStack`
  - **Notes** – Free text
- **Multi-tile layout editor** – Defines which sprites make up a multi-cell piece of furniture.
  - Arbitrary grid size (columns + rows adjustable).
  - Click a cell → activate it → click a sprite in the sheet → automatically jumps to the next cell.
  - Cells can be cleared individually.
  - Mini preview per cell taken directly from the sprite sheet.
- **Random-generator metadata:**
  - **Colors** – Chip selection (white, black, brown, …)
  - **Room types** – which rooms this tile is allowed to be used in
  - **Variant ID** – groups color/style variants of the same furniture type
  - **Style tags** – Modern, Rustic, … (saved, not yet active in the generator)
  - **Room type filter** – Tiles with at least one room type entry are only used in matching rooms. Tiles without a room type entry are treated as neutral and allowed everywhere.
- **Save / Delete** – Every definition is persisted as JSON on the backend.
- **Export** – Download the entire `tile-definitions.json` via a link.

---

### 📋 Furniture Browser

Read access to **BuildingFurniture files** (Project Zomboid's `.bf` format) for bulk-import support.

**What it can do:**

- **Path configuration** – Set the path to a `.bf` file (e.g. `BuildingFurniture_01.bf`). Saved persistently.
- **Directory browser** – Same file browser as in the Tile Browser.
- **Group list** – Lists all `group` blocks in the file with label, piece count, and entry count.
  - Search filter.
- **Detail view** – Shows all `furniture` entries (pieces) of a group with their orientations and tile IDs.
  - Mini sprite previews from the cached sprite sheets.
- **Multi-select** – Select multiple entries at once (checkboxes, also per piece).
- **Import as tile definition** – Selected entries are derived from the `.bf` structure as TileDefinition drafts and can be configured and saved directly.
  - Already-imported tiles are marked with an indicator.
  - **Same configuration fields as the Tile Browser** (group, colors, room types, variant ID, style tags, flags, notes).
    - Tiles with room types set are only used in matching rooms; empty room types = allowed everywhere.

---

### 🏠 Room Type Editor

Defines which furniture slots a room of a given type should have – the basis for a future automatic room decorator.

**What it can do:**

- **Room type management** – List of all known room types. Create new types or remove existing ones (including deleting their saved configuration).
- **Slot system** – Each room type has any number of slots. A slot is a "request" to the generator:
  - **Footprint (W × H)** – How many cells the piece of furniture occupies (1×1 to 5×5).
  - **Rotatable** – For non-square footprints, W and H can be swapped. Mini visualization of both orientations.
  - **Required / Optional** – Required slots are always filled.
  - **Priority** – Optional slots are drawn in priority order (0 = first).
  - **Count per room size** – Min/max table for XS / S / M / L / XL (max -1 = unlimited).
  - **Allowed categories** – Which tile groups qualify for this slot, with weighting (1–10).
  - **Placement rules** – Against the wall / At a door / At a window / Room center / Corners only / Allowed on path cells.
  - **Wall alignment** (only for "against the wall"): Automatic / ⊥ Perpendicular / ∥ Parallel.
  - **Fallback rules** – Ordered list of alternative placement rules. If the generator can't find a free position with the primary rules, it tries the fallbacks in order (only relevant for required slots).
  - **Layer filter** – Restricts to a specific furniture layer.
  - **Required properties** – e.g. `blocksPathing`, `wallMounted`, `canStack`.
  - **Variant group (one-of)** – Multiple slots in a group → the generator picks exactly one variant (weighted).
  - **Anchor slot** – Links this slot relative to another (e.g. a nightstand "HeadLeft" next to the bed).
- **Room type filter in the generator** – Tiles are automatically filtered by the current room type when furnishing. Only tiles whose `RoomTypes` list contains the room type, or that have no restriction (empty list), are selected.
- **Duplicate slot** – Quickly copy an existing slot.
- **Info panel** – Expandable explanation of all slot concepts.
- **Reference footer** – Shows common footprint grids and the room size scale as a quick-reference bar.
- **Save / Delete** – Configurations are persisted as JSON on the backend.
