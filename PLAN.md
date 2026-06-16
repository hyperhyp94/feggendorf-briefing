# PLAN: Feggendorf-Briefing v2 — Redesign

## Ziel
Frontend-Redesign: helles DWD-Stil-Design, bessere stündliche/tägliche Ansicht,
alle Parameter sichtbar mit Tooltips, Datenquellen-Validierung.

## Was bleibt (Backend)
- `server.js` + `lib/aggregate.js` + `lib/sources.js` → unverändert
- API: `/api/briefing` → JSON wie gehabt

## Was neu kommt (Frontend: `public/index.html` + `public/styles.css`)

### 1. Design: Hell, clean, DWD-Stil
- Hintergrund: `#f5f6f8`, Karten: weiß mit dezentem Schatten
- Schrift: System-Font (kein Space Grotesk mehr), lesbar
- Akzentfarbe: `#1a56db` (Blau, DWD-ähnlich)
- Kein Dark-Mode. Konservativ, funktional.
- Bessere mobile Lesbarkeit

### 2. Header
- Standort + Koordinaten kompakt oben
- Live-Bedingungen (DWD-Current) prominent
- Paraglidable-Fly-Score + Convek-Rating nebeneinander

### 3. Quellen-Checker (NEU)
- Status-Bar: alle 7 Quellen als kleine Chips (grün=ok, rot=Fehler)
- Bei Fehler: Fehlermeldung einblendbar
- So sieht man sofort ob alle Daten da sind

### 4. Stündliche Detailansicht (verbessert)
- Tabelle mit allen Parametern stündlich 8–20 Uhr
- Spalten: Wind (km/h + Richtung), Böen, Thermik (BLH, Cloudbase), Wolken (tief/mittel/hoch), CAPE, Regen%
- Zeilenfarbe nach Flyability (grün=fliegbar, gelb=grenzwertig, rot=ungeeignet)
- Tooltips bei jedem Spaltenkopf: Was bedeutet der Wert? Woher kommt er?

### 5. Tagesübersicht (verbessert)
- 10-Tage-Ribbon als Karten mit Mini-Balkendiagramm pro Tag
- Umschalter: Stündlich ↔ Täglich (Segmented Control)

### 6. Modellvergleich (verbessert)
- ICON / ECMWF / GFS nebeneinander
- Böen, Regen, Temperatur als kleine Multi-Balken
- Einigkeit-Ampel (grün=einig, gelb=Streuung, rot=uneinig)

### 7. DWD-Warnungen
- Als Karten mit Icon + Zeitraum
- Keine Warnungen = grüner Haken "Keine Warnungen aktiv"

### 8. Tooltips (NEU)
- Jeder Parameter kriegt ein `title`-Attribut mit:
  - Name + Einheit
  - Kurze Erklärung
  - Datenquelle
- Beispiel: `"Böenspitze (km/h) — Höchste Windgeschwindigkeit in der Stunde. Quelle: DWD ICON via Open-Meteo"`

## Dateien
- `public/index.html` → komplett neu
- `public/styles.css` → komplett neu
- `public/app.js` → angepasst an neue DOM-Struktur

## Keine Änderungen
- Backend (Node.js/Express) bleibt unverändert
- API-Schema bleibt identisch
- `lib/` bleibt wie es ist

## Vorgehen
1. PLAN.md → Freigabe durch Sven
2. `index.html` + `styles.css` + `app.js` schreiben
3. Server neustarten
4. Auf dem Handy testen lassen
