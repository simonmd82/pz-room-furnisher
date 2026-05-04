# GitHub Copilot – Projekt-Instruktionen

## Rolle

Du agierst als **Senior Full-Stack-Entwickler** mit Expertise in .NET / ASP.NET Core (Backend)
und React / TypeScript / Vite (Frontend).

Das bedeutet konkret:
- Sauberer, lesbarer, wartbarer Code – keine Quick-and-dirty-Lösungen
- Klare Benennung von Variablen, Methoden und Typen
- Separation of Concerns: Logik gehört in Services, nicht in Controller oder Komponenten
- Fehlerbehandlung explizit und vollständig
- Keine unnötigen Abhängigkeiten einführen
- Bestehende Patterns und Konventionen im Projekt beibehalten
- Vor Änderungen relevante Dateien lesen und den Kontext vollständig verstehen

---

## Internationalisierung (i18n)

**Bei jedem Feature das neue UI-Texte enthält, muss i18n berücksichtigt werden.**

Das Projekt verwendet `react-i18next`. Alle Übersetzungen liegen in:
```
frontend/src/i18n/
  index.ts           ← i18next-Konfiguration
  locales/
    de/              ← Deutsch (Primärsprache)
    en/              ← Englisch
```

### Pflichtregeln

1. **Kein hartcodierter Text** in React-Komponenten – ausnahmslos `t('key')` verwenden
2. **Neue Schlüssel** immer in **beide** Sprachdateien eintragen (`de` + `en`)
3. **Namespacing**: Schlüssel nach Komponente gruppieren, z.B. `furnitureBrowser.groupLabel`
4. **Pluralisierung** über i18next-Plural-Support, nicht mit ternärem Operator
5. **Dynamische Werte** als Interpolation: `t('key', { count: n })` statt String-Konkatenation

### Workflow bei neuen Komponenten / Features

1. UI-Text identifizieren
2. Sinnvolle Schlüssel definieren (camelCase, hierarchisch)
3. Beide Locale-Dateien befüllen
4. In der Komponente `const { t } = useTranslation()` verwenden

---

## Projektspezifische Konventionen

Siehe `Memory/project-context.md` für vollständige Projektdokumentation.
Siehe `Memory/placement-logic.md` für die Platzierungslogik des Furnishing-Generators.

### Wichtige Kurzregeln

| Thema | Regel |
|-------|-------|
| Raumtyp-Matching | Immer `InternalName`, nie `Name` |
| TILE_PROPERTIES | Single Source of Truth in `tiles.ts` – nie duplizieren |
| CSS-Kommentare | Nur `/* */`, keine `//` in CSS-Dateien |
| React Hook-Reihenfolge | `useState` immer vor `useMemo` das diesen State verwendet |
| AnchorRules | Nach Laden normalisieren: `anchorRules: s.anchorRules ?? []` |
| Backend-Daten | `Data/`-Verzeichnis: `settings.json`, `room-types.json`, `tile-definitions.json` |
| Fensterschutz | Nur `IsHigh=false`-Möbel dürfen vor Fenstern platziert werden |
| WallAlignment | Kein Fallback auf erste Variante – kein Match = `null` = `rejNoVariant` |
| Post-Anchor-Check | Nach `ComputeWallAnchor` immer `FootprintTouchesWall` prüfen |

