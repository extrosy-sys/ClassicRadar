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
"3D volumetric view" button (or the Volumetric products in the dropdown) → fetches 4 super-res tilts
for the nearest NEXRAD, decodes each (bzip2 → packet-16 raw radials, elevation from PDB hw21), and
plots every gate past threshold as a colored point at its true (az, slant-range, elevation) position
via 4/3-earth beam-height geometry (`h=√(r²+Rₑ²+2rRₑsinε)−Rₑ`, ground range `Rₑ·asin(r·cosε/(Rₑ+h))`),
Y-up with a vertical-exaggeration slider. Range capped 160 km, gate stride 2.
- **Two products** (in-view `#v3-prod` selector): Reflectivity N0B/N1B/N2B/N3B (dBZ, NWS ramp) and
  Velocity N0G/N1G/N2G/N3G (m/s, green inbound / red outbound; value=(level−129)·0.5). N0U velocity
  is retired — the super-res velocity is **N0G**.
- **Map floor**: `buildFloor()` stitches CARTO **Voyager** (labeled) z8 tiles over the ±160 km box
  onto a canvas → texture on an **explicit ground quad** (world verts X=east/Z=north, UVs pinned so
  north=+Z, east=+X, labels upright — the U had to be flipped [1,1/0,1/1,0/0,0]) + `MeshBasicMaterial`
  (unlit, always bright). Default **camera views from the SOUTH looking north** (`(40,165,-235)`) so
  the baked-in north-up map text reads correctly (viewing from the north side shows it reversed).
- **Opacity + Blob mode** (`makeMaterial`): Opac slider (default 55%) makes the cloud translucent
  with `depthWrite:false` so you see through the top tilt to the layers below. Mode = Points (square
  gates) or **Blobs** — a soft radial sprite (`getSprite`) turns each gate into a fuzzy transparent
  puff, so the overlap builds volumetric "clouds". Opac/Size/Mode update the material live.
- **Fill (interpolated slices)**: between adjacent tilts, `rebuild()` interpolates gate values by
  0.5° azimuth bucket (`buildGrid` indexes each tilt) at 1–2 intermediate elevations, filling the
  large vertical gaps between the 4 real tilts. Floor is the labeled CARTO **Voyager** map (opaque)
  so cities/roads read.
- **Animation**: Frames = 4/8 fetches the last K volume scans (`Level3.latestKeys` + `fetchTiltKey`
  per tilt code), builds a grid-indexed tilt set per frame, and the ▶ button loops them (rebuild per
  frame at 700 ms), interpolation and all.

## 3D Surfaces mode (marching cubes isosurfaces)
Mode = **Surfaces** (reflectivity) turns the point cloud into solid, homogeneous 3D shells like the
NOAA/GR2Analyst renders. `marchingcubes.js` = classic Lorensen-Cline marching cubes (canonical
edge/tri tables, base64-packed; validated against a synthetic sphere → verts exactly on radius).
`buildSurfaces()` grids the radar volume onto a Cartesian field (voxel-driven: per voxel compute
ground range + azimuth, sample each tilt's gate, vertically interpolate dBZ between the tilts' beam
heights `g·tanε + g²/2Rₑ`; lowest tilt extended to ground, above the top beam = echo-top), then runs
marching cubes at **4 adaptive nested levels** (threshold → ~storm peak) → MeshLambert meshes,
outer shells translucent, red core opaque, lit by ambient+2 directional lights. Opacity slider is
live (`setSurfaceOpacity`); threshold/Fill/V× rebuild. Grid 104×104×28 over ±160 km × 16 km.
- **Multi-radar combine** (`load` fetches primary + `nearbyRadars` 3 nearest WSR-88D within 260 km;
  `activeRadars`): every radar is gridded onto the same field offset by its east/north km from the
  primary (`eastNorthKm`), taking **max dBZ per voxel**. This fills the airspace one radar can't see —
  above all it fills each radar's **cone of silence** (blind directly overhead): verified ILN is blind
  over itself at 6 km, but neighbour IND (214 km away) samples that point at 4.6 km, so the combine
  fills it. Points mode also renders every radar (offset by rx/ry). Temporal loop stays primary-only.
  `window.CR_SITES` (set by app.js) supplies the site list.
  - **Velocity is NEVER combined** (`load` returns early when `product !== "refl"`): Doppler velocity
    is a *radial* measurement — each radar only sees the wind component along its own line of sight, so
    the same parcel reads inbound (green) to one radar and outbound (red) to another. Max-combining
    across radars just paints a meaningless red/green mash (true multi-Doppler wind synthesis is a
    different algorithm entirely). Only reflectivity (a perspective-independent scalar) is combined;
    velocity stays single-radar. Verified: KTLX velocity = 1 radar, KTLX reflectivity = 4 combined.

## Single-radar tilt viewer (click a radar) — reflectivity + velocity, with a toolset
Each WSR-88D site popup ("Radar site icons") has **Open this radar** (opens the single-radar view in
reflectivity), **Velocity** (same view in velocity), and **3D volume**. TDWR sites just get "Center on
this radar". The single-radar view renders ONE radar's super-res Level III tilt client-side — the *same*
decode the 3D view uses (`Level3.fetchTilt`) — as a flat georeferenced map overlay, plus a **top-right
toolset** (`#srvtool`) to slide through the tilts, toggle the product, and close back to the composite.
- `renderTilt` draws each radial onto a 1200² offscreen canvas — one annular arc-stroke per gate
  (canvas angle = `az−90°`, exactly; lineWidth = one gate's radial depth). Product config `SRV_PRODUCTS`:
  **refl** = codes N0B/N1B/N2B/N3B, dBZ = 0.5·L−33 on the NWS `DBZ_RAMP` (`dbzColor`), floor 5 dBZ; **vel**
  = N0G/N1G/N2G/N3G, m/s=(L−129)·0.5, green toward / red away (`velColor`, skip levels 0/1/255). Canvas →
  `toDataURL` → `L.imageOverlay` on the dedicated **`velocity` pane** (z260, above reflectivity, below the
  city labels), bounds = radar lat/lon ± (maxRange km → deg, capped `SRV_MAX_KM`=230). Flat-earth km→deg
  placement is self-consistent with the overlay bounds so gates land correctly (mercator stretch negligible).
- **Toolset** (`buildSrvTool`/`updateSrvLabels`): site id, a Refl|Vel segmented toggle (`setSrvMode`), a
  **vertical tilt slider** (0–3 → the 4 super-res tilt codes; up = higher tilt), a big **current-elevation**
  readout (the *actual* decoded `t.elevation`, e.g. 0.5°/2.4°, filled once each tilt decodes — briefly "…"
  while a slower velocity tilt is in flight), a mini legend (dBZ steps / green-red key), and a **×** close.
  The bottom-right dBZ `#legend` auto-hides in velocity mode. `srvLoadTilt` guards against a stale fetch
  (site/code changed mid-flight) so fast slider/toggle clicks never paint an old tilt.
- **Single-radar** by nature (velocity is radial — never combined; reflectivity is this site's own scan).
  While active it *owns the radar layer*: hides IEM + the RainViewer buffers, and `syncIem` early-returns on
  `srvActive` so a zoom doesn't bring the composite back under it. `closeSingleRadar` (also fired by ◉ LIVE
  and any product change) removes the overlay, restores the dBZ legend, and brings the composite back via
  `syncIem`. The radar-opacity slider drives the overlay too. Verified live at KABR: refl tilt 1 (0.5°, 13.6%
  cover), slider → tilt 3 shows the real 2.4°, toggle → velocity 0.5° with both inbound (green) + outbound
  (red) couplet, × restores the composite + legend — no console errors. Android app is 2D reflectivity only.
- **Radar site icons enlarged** for visibility: 11 px dots (was 7), 2 px white ring + dark halo; NEXRAD =
  blue circle, TDWR = magenta rounded square; hover → amber glow.

## Precipitation, symbol legend, track thinning (added 2026-07-21)
- **MRMS precipitation layers** (product dropdown "Precipitation (MRMS QPE)"): 1-hr (≈ rate), 24-hr
  (total), 72-hr (storm total), all in inches. Source = NOAA/NWS **MRMS QPE ImageServer** (keyless,
  CORS-open, EPSG:3857) at `mapservices.weather.noaa.gov/.../obs/mrms_qpe/ImageServer`. It serves NO
  XYZ tiles, so `PrecipTileLayer` (an `L.TileLayer` subclass) tiles it itself: each 256² tile is one
  `exportImage?bbox=<tile's web-merc bbox>&bboxSR=3857&imageSR=3857&size=256,256&format=png&f=image&
  renderingRule={"rasterFunction":"rft_1hr|rft_24hr|rft_72hr"}` call (server returns a colorized PNG).
  `applyProduct` src `precip` → `showPrecip(rule)`; clears frames/sat/IEM, hides the dBZ legend (which
  is refl-only now — also hidden for satellite), opacity slider drives it, static (no playbar).
- **Storm-cell symbol legend** (`#symlegend`, bottom-left by the zoom control): explains the marker
  glyphs ▼ Tornado/TVS · ◆ Meso/flood · ■ Severe/hail · ● Radar cell (bright color-coded on dark).
  Visibility follows the `c-cells` (storm-cell markers) toggle.
- **Track thinning by zoom** (`renderStorm`): tracks overlapped into mush when zoomed out (esp. the
  15/30/45/60-min tick dots+labels — ~8 elements × N cells). Now progressive: **z≥9** all tracks +
  ticks; **z8** all tracks, thinner, NO ticks (the ticks were the worst clutter); **z7** only
  significant (warning-linked / TVS) tracks, radar-only cells drop theirs; below z7 none (data gated).
  Verified live at KJKL: z9 = 39 paths/21 ticks, z8 = 84 paths/0 ticks, z7 = tracks thinned to the
  significant few. `TRACK_MIN_ZOOM`=7 still gates the Level III fetch.

## Alerts UX + sparse low-zoom tracks (2026-07-21)
- **Expiry timezone**: `fmtLocal` now includes `timeZoneName:"short"` → alert card expiries render in the
  viewer's local zone with the label (e.g. "Jul 21, 7:45 PM CDT"/EDT). Storm-table expiry stays UTC ("…Z").
- **Alert card collapse**: clicking an already-open card now collapses it (`collapseAlert` clears the open
  class + the persistent `alertSelLayer` highlight); clicking a closed one still opens/selects it.
- **Alert card hover → highlight**: `mouseenter`/`mouseleave` on each card call `hoverAlert(i)` (the same
  bold outline the overlap-picker uses, on `alertHoverLayer`), so hovering an alert shows exactly where it is.
- **Sparse storm field when zoomed out**: `TRACK_MIN_ZOOM` 7→5 and new `SPARSE_ZOOM`=7. Below z7 the field
  is drawn SPARSE — only significant (warning-linked / TVS) cell markers AND tracks (`sparse = z<SPARSE_ZOOM`
  gates the marker `addTo`; tracks already went significant-only below z8) — so tracks no longer vanish when
  zoomed out, they thin. Below z5 Level III still isn't fetched. (Verified z8 unchanged; the automated pane
  went zoom-frozen so z5–6 sparse wasn't visually re-confirmed, but the path is a simple threshold gate.)

## Verbose weather-alerts table (map-linked)
Third storm-panel tab **"Alerts (N)"** (beside Storm Attribute Table / Level III Text): every active NWS
alert — all event types (warnings, watches, advisories, statements) — whose polygon intersects the view,
with the full verbose text. `fetchAllAlertsCached` pulls the national `alerts/active?status=actual&
message_type=alert` once per 60 s (`alertsCache`), `loadAlerts` re-filters to the padded view by
`geomBBox` intersect (called from `loadStormData`, non-blocking + on every pan). `renderAlerts` sorts by
severity then expiry; `buildAlertsTable` renders one expandable card per alert (severity chip colored by
`SEV_COLOR`, event, expiry, areaDesc; click the header → open the headline + full description + PRECAUTIONARY
instructions + sender/effective/expires). Map link both ways: `drawAlertPolys` draws every in-view alert
area on the **`alerts` pane** (z380, below warn) when the **"All weather-alert areas"** clutter toggle
(`c-alerts`, default off) is on, each clickable → `selectAlert(i, fromMap)` opens its card + switches to the
tab; clicking a card highlights that alert on the `alertSelLayer` (warn pane, bold) and `flyTo`s it.
`selectedAlertUid` + `reapplyAlertSelection` keep the highlight/open-card across data refreshes (matched by
stable alert id). `esc()` HTML-escapes all alert text. Verified live near KJKL: 21 in-view alerts, full
921-char description + instructions, severity sort, both link directions, 29 area polygons. Web-only so far.
- **Overlapping-alert picker**: because alert areas stack, clicking one runs `onAlertAreaClick` → a
  ray-casting point-in-polygon (`geomContains`/`alertsAtPoint`) finds EVERY alert whose area covers the
  clicked point. 1 hit → select it directly; ≥2 → a Leaflet popup (`openAlertPicker`) lists them (severity
  chip + event). **Hovering a picker row** draws that alert's area bold on `alertHoverLayer` (`hoverAlert`,
  white halo + colored stroke, cleared on mouseout / `popupclose`); clicking a row selects it (card + fly +
  highlight) and closes the popup. Wired to BOTH the alert-area polygons (`drawAlertPolys`) and the
  default-visible storm-warning polygons (`renderStorm`), so overlapping warnings disambiguate even with the
  "All weather-alert areas" toggle off. Verified live: a Tornado Warning + Flood Advisory overlap → 2-item
  picker, each row highlights its own area on hover, click opens the card.

## Precip color key + echo tops (added 2026-07-21)
- **Precip color key** (`#precipkey`, bottom-right; `showPrecipKey`/`clearPrecipKey`): fetches the MRMS QPE
  ImageServer's OWN `legend?f=json&renderingRule={rasterFunction}` and renders its base64 swatches + inch
  tick labels — so the key always matches the tiles exactly (no hardcoded ramp). Shown for precip products,
  hidden otherwise (the dBZ `#legend` is already hidden for non-refl).
- **Echo tops (EET, product 135)** — `level3.js Level3.fetchEET(site3)` decodes the current Enhanced Echo
  Tops via the SAME bzip2 + packet-16 path as super-res reflectivity (`decodeReflectivity`), then returns a
  `sampleTop(azDeg, rangeNm)` closure (1° radials bucketed by azimuth, ~186 nm range → `gateNm=186/nbins`,
  small az/range window → max). **Encoding reverse-engineered from live data: topKft = (level & 0x7F) − 2**
  (low 7 bits − 2 kft; high bit 0x80 = "topped"/≥ flag; levels <3 → none) — verified: raw peaks 33-38 →
  31-36 kft, max 0x7f&192−2 = 62 kft. NSS (Storm Structure, has TOP directly) is NOT carried in the
  real-time Unidata bucket; EET IS, so tops come from EET.
- **Per-cell tops**: `loadStormData` fetches EET (cached 3 min, `fetchEETCached`) only for radars that
  returned NST cells; `renderStorm` samples each cell's `top` at its (az, range). Surfaced three ways:
  (a) **Storm-top callouts** map layer (`c-tops` toggle, `tops` pane z650, `.topbox` "▲NNkft" labels) —
  de-cluttered by `drawTopCallouts`: sorts cells tallest-first and places a label only if its screen box
  doesn't overlap one already placed, so zooming out keeps only the highest tops (re-runs per pan/zoom via
  renderStorm→latLngToContainerPoint). Verified z8=21 / z7=36 callouts, 0 overlapping pairs, tallest first;
  (b) a **Top (kft)** column in the storm attribute table; (c) the **alerts table** — `cellTops` +
  `alertMaxTop`/`annotateAlertTops` show the max echo top of any cell inside each alert's polygon (a chip in
  the card header + a line in the detail). Verified live at KJKL: 43 callouts (▲48kft…), 43 table rows with
  tops, alert cards showing Tornado-Warning tops of 51-52 kft.

## Persisted settings (localStorage)
The map controls + view survive reloads via `localStorage["classicRadar.prefs.v1"]` (not a cookie —
not sent to any server, no size cap, static site). `savePrefs` writes all clutter checkboxes
(`PREF_CHECKS`), the product/frames/speed/dwell/network selects (`PREF_SELECTS`), radar opacity, and the
map center/zoom on any control `change` or map `moveend` (wired by `wirePrefSaving`). At boot `restorePrefs`
applies saved values BEFORE `applyProduct`/`loadWarnings` read them (guards: a `d3` volumetric product falls
back to N0B so the 3D view doesn't auto-open; only valid option values are set); `restoredView` makes boot
skip `centerOnSite`. `applyRestoredLayers` then dispatches each toggle's `change` (+ opacity `input`) so
restored layer/opacity states actually take effect — saving is wired last so restore doesn't feed back.
Verified: product NCR, frames 24, opacity 45, c-city off, c-watches/c-tops on, and the map view all restore
across a reload and re-apply (composite tiles load, watches draw, labels hidden).

## Added weather products/overlays (2026-07-21, all toggle-able)
- **SPC Day-1 Convective Outlook** (`c-outlook`, `outlook` pane z340): `loadOutlook` fetches the SPC
  categorical GeoJSON (`spc.noaa.gov/products/outlook/day1otlk_cat.nolyr.geojson`) — it ships its own
  `stroke`/`fill` risk colors (TSTM/MRGL/SLGT/ENH/MDT/HIGH). Popup = risk label.
- **SPC Watches** (`c-watches`, `watches` pane z385): `loadWatches` via IEM `spcwatch.py?fmt=geojson`
  (CORS-open) — TOR=red / SVR=amber boxes; popup = number, PDS, hail/wind, expiry.
- **Surface obs / METAR** (`c-metar`, `metar` pane z660): `loadMetar` — aviationweather.gov is NOT
  CORS-open, so it uses IEM per-state `currents.geojson?network=XX_ASOS` (CORS `*`). A `STATE_BBOX`
  table picks the ≤6 states overlapping the view; obs merged, filtered to view, **de-cluttered** (same
  greedy screen-box overlap test as tops), rendered as temp°F + a rotated wind arrow (`makeMetarMarker`);
  popup = T/Td/wind/gust/wx + raw METAR. Refetched on pan (moveend) when active.
- **Air Mass RGB** satellite (product `WV`, GIBS `GOES-East_ABI_Air_Mass`) — water-vapor/dynamics (the
  individual GIBS WV bands 400'd; Air Mass is the working moisture product).
- **Dual-pol in the single-radar tilt viewer**: the mode picker is now a dropdown (`#srv-mode`) with
  Reflectivity / Velocity / **Corr Coef (CC, N0C)** / **Diff Refl (ZDR, N0X)**. Encodings: CC = 0.2 +
  (L−2)·0.00336 (`ccColor`: red<0.8 … blue≥0.98), ZDR = (L−2)·0.0625 − 7.875 dB (`zdrColor`). Decode reuses
  the same bzip2 packet-16 path. Verified live CC + ZDR render (~17% cover) with their own legends.
- **My location (GPS)** action button: `navigator.geolocation` → pulsing blue marker + setView + reload.
  **IP fallback** (`ipLocate`): if the GPS API is missing OR getCurrentPosition errors/denies/times out, it
  falls through to keyless CORS-open IP geolocation (tries ipapi.co → geojs.io → ipwho.is in order) and drops
  a non-pulsing amber "approx" marker. Verified: GPS-fail → IP → "Approx location (Minneapolis) via IP ·
  nearest radar KMPX".
- Force-refresh on "Reload data" clears `geoCache`/`eetCache`/`alertsCache` and reloads all vector layers.
- NOT feasible keyless (reported, not added): national MRMS **MESH/VIL/rotation/echotop** grids (NCEP
  OpenGeo serves only base+composite reflectivity); HRRR model radar; cross-section; VWP; SPC Mesoscale
  Discussions (no reliable CORS GeoJSON found).

## Base vs Composite reflectivity (real products, not a color swap)
Base and Composite were BOTH RainViewer/IEM before, so the LIVE view showed identical IEM n0q tiles →
toggling did nothing (fixed 2026-07-21). Now the reflectivity "still" is product-aware (`showIem` +
`isComposite`): **Base Reflectivity 0.5°** = IEM `nexrad-n0q` (0.5° base), **Composite Reflectivity** =
NCEP MRMS composite reflectivity WMS (`opengeo.ncep.noaa.gov/geoserver/conus/conus_cref_qcd`, keyless,
CORS-open, EPSG:3857, column-max). `showIem` keeps a single active still and swaps type on product change
(verified both directions). The PLAY loop is still RainViewer for both (only free animated national radar);
`c-iem` forces the still on. Opacity slider drives both stills.

## Satellite & 2D reliability
- **Satellite** (NASA GIBS / GOES-East, keyless, full-disk): products "Infrared (cloud tops)" =
  `GOES-East_ABI_Band13_Clean_Infrared` (Level6) and "GeoColor (visible)" = `GOES-East_ABI_GeoColor`
  (Level7). GIBS WMTS REST is `{z}/{y}/{x}` (row/col) — matches Leaflet's `{z}/{y}/{x}`. `time=default`
  gives the latest scan. Static (playbar disabled).
- **RainViewer loop = TWO double-buffered layers** (`buffers[2]`/`frontBuf`, `showFrame`): the hidden
  buffer preloads the next frame (`setUrl` + `_crFrame`), then the tick swaps by opacity — instant,
  the visible layer is never cleared (no strobe) and only ~2 frames load at once (not the old 12-layer
  ~600-request burst that RainViewer dropped). Verified: across a full loop the visible layer is always
  exactly one and always fully loaded.
- **IEM is the reliable default at EVERY zoom** (`goLive`/`syncIem`): RainViewer's free tile server is
  flaky (intermittent misses, ~2 km mosaic that blocks up when zoomed), so the map shows the crisp
  IEM current scan by default. **PLAY** switches to the RainViewer loop (`showFrame` sets `usingFrames`,
  hides IEM); **◉ LIVE** returns to IEM. This fixes "radar disappears when zoomed out / tiles come and
  go". RainViewer clamped `maxNativeZoom:7`, IEM `maxNativeZoom:12`.
- **Tile status** (`#tilestatus`, `attachRetry(layer,name)`): shows "loading tiles…" and, after 2
  cache-busted retries, "N tile(s) failed" (red) — surfaces the flakiness instead of silent holes.
- **Radar site icons** (`buildSiteMarkers`, `c-sites`): all 204 NEXRAD/TDWR sites as small dots; click →
  popup with "Open this radar" (selects + zooms) and "3D volume" (opens the volumetric view for it).

## Storm tracks — multi-radar + declutter
`loadStormData` fetches NST from EVERY WSR-88D whose site is in view (nearest `MAX_L3_SITES`=5,
3-min `l3Cache`), so a whole storm field is covered, not just one radar — verified 3 radars
(KILN,KRLX,KLVX) at once. Below `TRACK_MIN_ZOOM`=7 it skips Level III entirely so tracks/cells don't
overlap into mush (only NWS warnings show). Cells keyed by unique `key` (`id#siteIdx`) since ids
collide across radars; display stays the short id.

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

## Resizable + pop-out storm panel (desktop)
- **Drag-resize**: a `#tableresize` divider sits between the playbar and `#tablewrap`; dragging it (pointer
  events, `setupPanelResize`) sets the panel height (clamped 90px … stage−210) and calls
  `map.invalidateSize` so Leaflet reflows. `#mapwrap` min-height dropped to 160 so the panel can grow.
- **Pop-out to its own window**: the `⧉ Pop out` button in `#tablebar` (`popOutPanel`) opens a `window.open`
  window, writes a minimal doc that `<link>`s the same `styles.css` (absolute URL), then **moves the live
  `#tablewrap` node** into it via `adoptNode` (a `panelHome` comment marks its spot in `#stage`, which gets
  `.panel-popped` so the map fills). Because the panel DOM now lives in another document, **all panel-scoped
  lookups go through `panelDoc`** (`P(id)`/`Pq(sel)` + `panelDoc.querySelectorAll`) — `buildTable`,
  `buildAlertsTable`, `renderStorm`'s text/status writes, `showTab`, `setTableStatus`, `selectRow`,
  `hoverCell`, `selectAlert`, `reapplyAlertSelection`. Event listeners persist on the moved nodes, so
  clicking a row/card/tab in the popup still drives the map in the opener. The same button (now
  `⧉ Dock back in`) or closing the window (`beforeunload`) calls `dockPanel`, which `adoptNode`s the panel
  back to `panelHome` and restores `panelDoc = document`. Resize + pop-out are hidden on mobile.
  Verified (via a same-origin iframe stand-in, since the automated pane blocks `window.open` for synthetic
  clicks — real clicks work): drag 200→320px; pop-out moves the panel out (map fills, styles link, tab
  clicks in the popup redirect through `panelDoc`); dock-back restores it and main-doc rendering resumes.

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
