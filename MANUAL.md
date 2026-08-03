# Classic Radar — User Manual

A field guide to every control. Features marked **◆** need the optional enhancement server
(see [Enhancement server](#enhancement-server)); everything else works from the bare page.

## The layout

- **Sidebar** (left; ☰ on mobile): radar site, product, animation, clutter toggles, actions, server.
- **Map stage**: the map, directional pan buttons (classic no-drag nav — drag/zoom work too),
  dBZ legend, product color keys, storm-cell symbol legend.
- **Playbar**: LIVE / PLAY / step buttons, frame scrubber, loop range, **time-machine slider**.
- **Storm panel** (bottom; resizable, pop-out): Storm Attribute Table · Alerts · Level III Text.

## Products (the main dropdown)

| Group | Products | Notes |
|---|---|---|
| Reflectivity | Base 0.5° (IEM) · Composite (MRMS) | Crisp national stills; PLAY animates (◆ = 24-h z12 archive loops, keyless = RainViewer ~2 h) |
| Satellite | Infrared · GeoColor · Air Mass RGB | GOES-East, ~10-min imagery; all animate |
| Precipitation | 1 h · 24 h · 72 h QPE | Accumulations in inches (static) |
| Canada | Rain · Snow composites | Environment Canada GeoMet; ~3-h animated history, keyless |
| Winds — animated | sfc · 850 · 700 · 500 · 250 mb | Flowing particles colored by speed (kt); ◆ = fine GFS grid |
| ◆ Severe weather | MESH hail · VIL · rotation tracks · NLDN lightning · 1-h rainfall · 24-h hail swath | MRMS grids decoded by the server; all animate |
| Volumetric | 3D reflectivity / velocity | Opens the 3D view (below) |

## Animation & the time machine

- **PLAY** loops the current product; frames select = loop length (6–24 frames, ◆ 3 h/6 h/24 h).
- **◉ LIVE** returns to the current still (and unpins the time machine).
- **Frame slider** scrubs within the loop; speed + dwell selects control pacing.
- **◆ "end" slider** (right of the playbar): drags the loop's END back through the last 24 hours —
  replay this morning's squall line at 09Z, then switch products and the pin follows (radar@09Z ↔
  satellite@09Z ↔ rainfall@09Z). Amber label = pinned.
- At national zoom (◆), loops use pre-assembled whole-US frames — no tile flicker, ever.

## The storm panel

- **Storm Attribute Table** — the classic: cell ID, threat glyph (▼ TVS ◆ meso ■ hail),
  event, hail size, wind gust, motion, echo top (kft), VIL, area, expiry. All decoded from raw
  NEXRAD **Level III** in your browser (NST/EET/DVL) across every radar in view, merged with NWS
  warning tags. Click a row ↔ its map marker (both directions).
- **Alerts** — every active NWS product intersecting the view, severity-sorted, full verbose
  text; click a card ↔ its polygon; overlapping areas get a picker. ◆ = slim payloads.
- **Level III Text** — the raw tabular alphanumeric block, exactly like the old site.

## Single-radar tilt viewer & 3D

- Click any WSR-88D dot → **Open this radar**: its own super-res tilt rendered client-side.
  Toolset: tilt slider (4 tilts, live decoded elevation), product spinner — Reflectivity,
  **Velocity**, **Correlation Coefficient**, **Differential Reflectivity** — and ✕ to close.
- **3D volumetric view**: the radar volume as points / soft blobs / **marching-cubes isosurfaces**,
  vertical exaggeration and dBZ threshold sliders, multi-radar combine (fills the cone of
  silence), 4/8-frame animation. Velocity is never multi-radar combined (it's a radial quantity).

## Map layers (clutter toggles)

| Toggle | What you get |
|---|---|
| Warning polygons | TOR/SVR/FFW/SMW, filled, clickable |
| All weather-alert areas | every alert type, color by severity, overlap picker |
| Storm-cell markers / tracks | Level III cells + 15/30/45/60-min forecast tracks, zoom-thinned |
| Echo-top callouts | de-cluttered ▲kft labels, tallest first |
| SPC watches / outlook / **mesoscale discussions** | watch boxes, Day-1 categorical, MD polygons with watch-confidence |
| Tropical (NHC) ◆ | forecast cones, tracks, D/S/H/M points, watch/warning coasts, **past track + past positions**, dev areas |
| Wildfires (NIFC) | 🔥 incidents sized by acreage (dimmed = prescribed), mapped perimeters, Canadian satellite hotspots |
| Smoke (NOAA HMS) ◆ | analyst plumes, light/medium/heavy |
| Air quality (EPA AirNow) | AQI contours in the six standard colors |
| Surface obs (METAR) | de-cluttered station plots; click → data + **plain-English decode** (◆ = denser aviation/mesonet obs); includes Canadian provinces |
| Radar site icons | all 204 NEXRAD/TDWR sites (blue/magenta) |
| Auto-refresh (2 min) | still + vectors refresh with a countdown; held while playing |
| Chime on new warning | two-tone alert when a never-seen warning appears in view |
| Click map → point forecast | 12-h table + CAPE + **current AQI**, anywhere in North America |

## Actions

**Reload data** (force-refresh everything) · **Center on site** · **My location** (GPS, falls
back to IP geolocation) · search box takes city, ZIP, or radar ID.

Everything persists across reloads (product, layers, opacity, view) — locally, no accounts.

## Enhancement server

A single self-contained Windows exe (`ClassicRadarServer.exe`) you run on any spare
machine/VM. The site probes it automatically (green **◆ ENHANCED** badge) and degrades
silently if it's off. It adds: 24-h archives + whole-US composite frames for every loop, the
◆ severe grids, fine wind grids, smoke, tropical, the time machine, slim alerts, aviation +
Synoptic mesonet obs, air-quality caching — and **phone push notifications** for warnings at
your saved locations via the free ntfy app (no account, no HTTPS hassle: see README-VM.txt in
the deploy zip). Setup: unzip, `ClassicRadarServer.exe --port 8778 --site .\site`, browse it.

## Android

The native companion app mirrors the feature set — its own Level III binary decoder, storm
table, alerts, tilt viewer, all the overlay layers, animated winds, server support with the
same graceful fallback — as a sideload APK (no Play Services, no tracking).

## Data sources (all free, no keys)

NWS/NOAA (alerts, radar sites, MRMS, NODD, HMS, NOMADS GFS, AWC), Iowa Environmental Mesonet,
NASA GIBS (GOES), RainViewer, Environment and Climate Change Canada GeoMet, NRCan CWFIS,
NIFC WFIGS, EPA AirNow, NHC, SPC, Open-Meteo, CARTO/Esri basemaps, Unidata Level III S3.

*Verify all warnings through official channels. This is an enthusiast tool, not a safety device.*
