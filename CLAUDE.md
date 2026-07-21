# Classic Radar

A recreation of the **pre-acquisition Weather Underground NEXRAD product selector** —
the clinical, data-dense radar page (not the WunderMap). Static, no build step:
open `index.html` or serve the folder.

## Run
- `python -m http.server 8777 --directory C:\Claude\ClassicRadar` then http://localhost:8777
- Registered in `C:\Claude\.claude\launch.json` as `classic-radar` (port 8777).
- Must be served over http:// (not file://) so `fetch` gets a real origin. All APIs are CORS-open.

## Live data sources (all free, no API key)
| Feature | Source | Endpoint |
|---|---|---|
| Radar site list (NEXRAD + TDWR) | NWS API | `api.weather.gov/radar/stations?stationType=WSR-88D,TDWR` |
| Storm attribute table + warning polygons | NWS API | `api.weather.gov/alerts/active?status=actual&message_type=alert` |
| Base Reflectivity 0.5° (true dBZ, still) | Iowa Env. Mesonet | `mesonet.agron.iastate.edu/.../nexrad-n0q-900913/{z}/{x}/{y}.png` |
| Composite Reflectivity (animated loop) | RainViewer | `api.rainviewer.com/public/weather-maps.json` (color scheme 6) |
| Gray base / labels | CARTO | light_nolabels / light_only_labels |
| Boundaries / highways | Esri ArcGIS Online | World_Boundaries_and_Places / World_Transportation |

Fallback radar-site list is embedded in `sites.js` (used only if the NWS station
request fails).

## Published
- **Live (GitHub Pages):** https://extrosy-sys.github.io/ClassicRadar/  (public repo
  `extrosy-sys/ClassicRadar`, served from `master` root). Android companion is the PRIVATE repo
  `extrosy-sys/ClassicRadar-Android`. All data sources are HTTPS + CORS-open, so the static
  Pages site works with no backend.

## Files
- `index.html` — layout: sidebar (site/product/loop/clutter/actions), map stage with
  directional pan buttons + dBZ legend, playback bar, storm panel (table / Level III text tabs).
- `styles.css` — clinical boxy look; Arial chrome, Courier data; 3D overlay styles.
- `app.js` — all logic (single IIFE, Leaflet 1.9.4 from unpkg CDN).
- `level3.js` — client-side NEXRAD Level III decoder. NST (storm track, via pako/zlib) AND
  super-res reflectivity tilts N0B/N1B/N2B/N3B (`fetchTilt` → bzip2 symbology + packet-16 radials).
- `bzip2.js` — pure-JS bzip2 decoder (antimatter15), **patched**: the output buffer now grows
  (the final-RLE output of a 900 KB BWT block can exceed it — the stock lib truncated at 900000).
- `volume3d.js` — Three.js (r128) volumetric "MRI" storm view; OrbitControls; dBZ/vertical-
  exaggeration sliders; `preserveDrawingBuffer` on so it can be screenshotted.
- `sites.js` — fallback station list.

## 3D volumetric storm view (`volume3d.js`)
"3D volumetric view" button → fetches the 4 super-res reflectivity tilts (N0B/N1B/N2B/N3B) for the
nearest NEXRAD, decodes each (bzip2 → packet-16 raw radials, dBZ = 0.5·level−33, elevation from
PDB hw21), and plots every gate ≥ threshold as a colored point at its true (az, slant-range,
elevation) position via 4/3-earth beam-height geometry (`h=√(r²+Rₑ²+2rRₑsinε)−Rₑ`, ground range
`Rₑ·asin(r·cosε/(Rₑ+h))`), Y-up with a vertical-exaggeration slider. Verified: KRLX → 4 tilts
(0.5/1.3/2.4/3.1°), ~73 k points, orbit/zoom/pan. Range capped at 160 km, gate stride 2 for perf.

## Level III on the web (added 2026-07-21 — parity with the Android app)
The Unidata bucket `unidata-nexrad-level3.s3.amazonaws.com` sends `Access-Control-Allow-Origin: *`,
so the browser decodes Level III directly — **no backend**. `level3.js` mirrors the validated
Kotlin/Python pipeline: strip WMO/AWIPS text header → `pako.inflate` (only if a zlib header sits
in the first 80 bytes — uncompressed super-res products like N0B otherwise) → scan for the Message
Header Block → radar lat/lon + product code + volume time → extract the Tabular Alphanumeric Block
(raw text → "Level III Text" tab) → for NST (code 58) parse each cell's az/range (→lat/lon),
motion, and 15/30/45/60-min forecast track (drawn as an amber dashed polyline). Latest file =
list bucket by `SITE_NST_YYYY_MM_DD` prefix, take last key, walk back ≤3 UTC days. Site = nearest
WSR-88D to the map center. Cells merge with NWS warnings (nearest ≤40 km) for hail/wind/threat.
Reflectivity **tilt** products for a 3D view exist too (`N0B/N1B/N2B/N3B`, super-res, current) —
that volumetric view is the next build.

## Classic-WU features implemented
- Raw product **selector** (base refl / composite / velocity / VIL / echo tops) with
  elevation-tilt dropdown. Both reflectivity products **animate** (RainViewer, different color
  scheme); velocity/VIL/echo-tops show an honest "single-site Level III" note.
- **Server-loop-style animation**: selectable frame count (6/12/18/24), speed, and
  last-frame dwell; play/pause/step/scrub. Frames are real ~10-min RainViewer scans covering the
  last ~2 h (historical, pulled on demand — nothing stored server-side). The optional **IEM
  true-dBZ still** (`c-iem`) overlays the crisp current national mosaic.
- **Directional pan buttons** (N/NE/E/…), classic non-drag navigation (drag/zoom also work).
- **Clutter toggles**: base map, county/admin borders, highways, city labels,
  warning polygons, storm-cell markers, plus a radar-opacity slider.
- **Storm attribute table** driven by live NWS warning parameters: alphanumeric cell IDs
  (A0, B1, …), threat glyph (▼ TVS/tornado, ◆ flood, ■ hail), event, max hail size (in),
  max wind gust (kt), storm motion direction + speed (kt) parsed from
  `eventMotionDescription`, area, and expiry.
- **Table <-> map cross-reference** (the signature feature): every table row's alphanumeric
  ID matches a labeled marker on the map. Hovering a row highlights its marker and vice
  versa; selecting a row (or tapping its marker) pins it with a pulsing yellow ring, fills
  that storm's warning polygon, and flies the map to it. `selectRow`/`hoverCell` in app.js;
  refs kept in `cellRefs{id -> {marker, poly, ...}}`.

## Responsive / mobile
Single responsive layout (no separate "mobile mode" build). Breakpoint `max-width: 760px`:
sidebar collapses into a drawer toggled by the ☰ button in the masthead (`body.controls-open`),
map + table stack vertically, bigger tap targets. Picking a site auto-closes the drawer;
selecting a storm row scrolls the map into view so the ping is visible. `map.invalidateSize()`
is called on toggle/resize. NOTE: the drawer uses `display:none/block` (NOT a max-height
transition) on purpose — a max-height animation renders fine in real browsers but gets stuck
mid-transition in the automated Browser-pane preview, which throttles animation frames.

## Known gaps vs. the original
- Cell **id / position / motion / forecast track** now come from real Level III (NST). Per-cell
  **max dBZ / VIL / echo-top** and **hail probability** are in *other* Level III products
  (DVL/EET/NHI) not yet decoded — those columns show "—" (the raw numbers appear in the Level III
  Text tab where the tabular includes them). Hail/wind still come from NWS warning tags, merged
  onto the nearest tracked cell.

## Verified 2026-07-21 (this round)
- Fixed: world-wrap double-render (`noWrap` + `maxBounds`); Leaflet zoom control moved to
  bottom-left (was on the pan grid); missing warnings (now event-filtered fetch → the relevant
  warnings aren't truncated out of a 367-item national list); warning polygons filled/highlighted
  by default (fillOpacity 0.15, 0.38 when selected); all left-menu settings apply live (no Reload).
- **Level III live**: KILN decoded 19 cells, KOKX 23, KRLX 34 — real current volumes (17:0xZ),
  motion + forecast tracks drawn, raw storm text in the Level III Text tab. Table↔map link intact.
- PLAY animates the RainViewer historical loop (12→3 frame advance confirmed).
- The Browser-pane screenshot tool times out on the live-tile map — verify via DOM/JS introspection.
