/* =====================================================================
   CLASSIC RADAR  -  a recreation of the pre-acquisition Weather
   Underground NEXRAD product selector.

   Live data sources (all free, no key, CORS-enabled):
     - api.weather.gov/radar/stations   -> full NEXRAD + TDWR site list
     - api.weather.gov/alerts/active     -> warnings -> storm attribute table
     - IEM nexrad-n0q tile cache         -> true-dBZ national base reflectivity
     - RainViewer weather-maps.json      -> timestamped frames for looping
   ===================================================================== */
(function () {
"use strict";

/* -------- NWS standard reflectivity color ramp (dBZ -> hex) -------- */
var DBZ_RAMP = [
  [5,"#04e9e7"],[10,"#009ff4"],[15,"#0300f4"],[20,"#02fd02"],
  [25,"#01c501"],[30,"#008e00"],[35,"#fdf802"],[40,"#e5bc00"],
  [45,"#fd9500"],[50,"#fd0000"],[55,"#d40000"],[60,"#bc0000"],
  [65,"#f800fd"],[70,"#9854c6"],[75,"#fdfdfd"]
];

/* ============================= MAP ============================= */
var map = L.map("map", {
  center: [35.33, -97.28],   // KTLX / Oklahoma City - classic severe-wx home
  zoom: 7,
  zoomControl: false,        // re-added bottom-left so it doesn't sit on the pan grid
  worldCopyJump: false,
  maxBounds: [[-84, -178], [84, 178]],
  maxBoundsViscosity: 0.9,
  attributionControl: true
});
map.attributionControl.setPrefix(false);
L.control.zoom({ position: "bottomleft" }).addTo(map);

/* The storm panel (#tablewrap) can pop out into its own browser window; when it does, its
   DOM lives in that window's document. All panel-scoped lookups go through panelDoc so the
   render/select code targets whichever document currently holds the panel. */
var panelDoc = document, panelWin = null, panelHome = null;
function P(id) { return panelDoc.getElementById(id); }
function Pq(sel) { return panelDoc.querySelector(sel); }

function pane(name, z) { map.createPane(name); map.getPane(name).style.zIndex = z; }
pane("radar", 250);
pane("velocity", 260);
pane("outlook", 340);         // SPC convective-outlook risk areas (background)
pane("clutter", 350);
pane("alerts", 380);
pane("watches", 385);         // SPC watch boxes
pane("warn", 400);
pane("sites", 500);
pane("track", 620);
pane("cells", 640);
pane("tops", 650);
pane("metar", 660);           // surface-observation station plots (top)

/* base + clutter tile layers */
var layers = {
  base: L.tileLayer("https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png",
        { subdomains:"abcd", maxZoom:18, noWrap:true, attribution:"&copy; OpenStreetMap, &copy; CARTO" }),
  county: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
        { pane:"clutter", maxZoom:18, maxNativeZoom:16, noWrap:true, opacity:0.9, attribution:"Boundaries &copy; Esri" }),
  hwy: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
        { pane:"clutter", maxZoom:18, noWrap:true, attribution:"Transportation &copy; Esri" }),
  city: L.tileLayer("https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png",
        { subdomains:"abcd", pane:"clutter", maxZoom:18, noWrap:true })
};
layers.base.addTo(map);
layers.city.addTo(map);

/* ============================= RADAR ============================= */
var IEM_URL = "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png";
var MRMS_CREF_URL = "https://opengeo.ncep.noaa.gov/geoserver/conus/conus_cref_qcd/ows?";  // MRMS composite reflectivity
var iemLayer = null;          // live still: IEM n0q base reflectivity (base product)
var compLayer = null;         // live still: NCEP MRMS composite reflectivity (composite product)
var buffers = [];             // two RainViewer layers, double-buffered (swap by opacity, no strobe)
var frontBuf = 0;             // which buffer is currently visible
var frameUrls = [];           // per-frame tile-URL templates
var frameTimes = [];          // unix seconds per frame
var curFrame = 0;
var playing = false;
var timer = null;
var dwellLeft = 0;

function radarOpacity() { return parseInt(document.getElementById("opacity").value, 10) / 100; }

/* ---- tile loading / error status (bottom of the map) ---- */
var tileErrCount = 0, tileStatusTimer = null;
function setTileStatus(msg, kind) {
  var el = document.getElementById("tilestatus");
  if (!el) return;
  el.textContent = msg || "";
  el.className = kind || "";
  el.style.display = msg ? "block" : "none";
  clearTimeout(tileStatusTimer);
  if (msg && kind === "err") tileStatusTimer = setTimeout(function () { el.style.display = "none"; }, 4000);
}

/* Re-request tiles that fail to load (transient RainViewer / rate-limit misses that would
   otherwise leave a hole), and surface loading / error status. Up to 2 retries, cache-busted. */
function attachRetry(layer, name) {
  var label = name || "Radar";
  layer.on("loading", function () { tileErrCount = 0; setTileStatus(label + " — loading tiles…", "load"); });
  layer.on("load", function () { setTileStatus("", "ok"); });
  layer.on("tileerror", function (e) {
    var t = e.tile;
    if (!t) return;
    t._retry = (t._retry || 0) + 1;
    if (t._retry <= 2) {
      var base = t.src.split("#")[0];
      setTimeout(function () { t.src = base + "#r" + t._retry; }, 400 * t._retry);
    } else {
      tileErrCount++;
      setTileStatus(label + " — " + tileErrCount + " tile(s) failed to load", "err");
    }
  });
  return layer;
}

/* ---- satellite (NASA GIBS / GOES-East), reliable full-disk coverage ---- */
var satLayer = null;
var GIBS = {
  ir:  { url:"https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-East_ABI_Band13_Clean_Infrared/default/default/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png",
         maxNative:6, opacity:0.85 },
  vis: { url:"https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-East_ABI_GeoColor/default/default/GoogleMapsCompatible_Level7/{z}/{y}/{x}.jpg",
         maxNative:7, opacity:0.95 },
  wv:  { url:"https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-East_ABI_Air_Mass/default/default/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png",
         maxNative:6, opacity:0.9 }
};
function clearSat() { if (satLayer) { map.removeLayer(satLayer); satLayer = null; } }
function showSat(kind) {
  clearSat();
  var g = GIBS[kind]; if (!g) return;
  satLayer = attachRetry(L.tileLayer(g.url, { pane:"radar", opacity:g.opacity, maxZoom:18,
    maxNativeZoom:g.maxNative, noWrap:true, attribution:"Satellite &copy; NASA GIBS / NOAA GOES-East" }), "Satellite").addTo(map);
}

/* ---- MRMS precipitation (NOAA/NWS QPE, keyless, EPSG:3857 ImageServer) ----
   The ImageServer serves no XYZ tiles, so we tile it ourselves: each 256² tile is one
   exportImage call for that tile's Web-Mercator bbox, colored by a QPE accumulation
   rasterFunction (rft_1hr = last hour ≈ rate, rft_24hr = daily total). All in inches. */
var precipLayer = null;
var MRMS_EXPORT = "https://mapservices.weather.noaa.gov/raster/rest/services/obs/mrms_qpe/ImageServer/exportImage";
var MRMS_LEGEND = "https://mapservices.weather.noaa.gov/raster/rest/services/obs/mrms_qpe/ImageServer/legend";
var WEBMERC_MAX = 20037508.342789244;
var PrecipTileLayer = L.TileLayer.extend({
  getTileUrl: function (coords) {
    var res = (2 * WEBMERC_MAX) / (256 * Math.pow(2, coords.z));
    var minx = -WEBMERC_MAX + coords.x * 256 * res, maxx = minx + 256 * res;
    var maxy =  WEBMERC_MAX - coords.y * 256 * res, miny = maxy - 256 * res;
    var rule = encodeURIComponent(JSON.stringify({ rasterFunction: this.options.rasterFunction }));
    return MRMS_EXPORT + "?bbox=" + minx + "," + miny + "," + maxx + "," + maxy +
      // png32, NOT png: plain png comes back as PNG24 with no alpha channel, so every
      // no-data pixel would paint solid black over the basemap (found via the Android port)
      "&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image&renderingRule=" + rule +
      (this._crBust ? "&_=" + this._crBust : "");
  }
});
function clearPrecip() { if (precipLayer) { map.removeLayer(precipLayer); precipLayer = null; } }
function showPrecip(rule) {
  clearPrecip();
  precipLayer = attachRetry(new PrecipTileLayer("", { pane:"radar", opacity:radarOpacity(),
    rasterFunction:rule, maxZoom:18, maxNativeZoom:12, noWrap:true,
    attribution:"Precip &copy; NOAA/NWS MRMS QPE" }), "MRMS precip").addTo(map);
  showPrecipKey(rule);
}

/* precipitation color key — the MRMS ImageServer's own legend swatches, so it matches the tiles */
function clearPrecipKey() { var el = document.getElementById("precipkey"); if (el) { el.style.display = "none"; el.innerHTML = ""; } }
function showPrecipKey(rule) {
  var el = document.getElementById("precipkey"); if (!el) return;
  el.innerHTML = '<div class="pk-title">Precip (in)</div><div class="pk-ramp pk-load">loading…</div>';
  el.style.display = "block";
  var url = MRMS_LEGEND + "?f=json&renderingRule=" + encodeURIComponent(JSON.stringify({ rasterFunction: rule }));
  fetch(url).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
    var leg = j && j.layers && j.layers[0] && j.layers[0].legend;
    if (!leg || !leg.length) { el.innerHTML = '<div class="pk-title">Precip (in)</div>'; return; }
    function lb(e) { var m = (e.label || "").match(/([\d.]+)/); return m ? m[1] : ""; }
    var ramp = leg.map(function (e) {
      return '<img class="pk-sw" title="' + esc(e.label) + '" src="data:' + (e.contentType || "image/png") + ";base64," + e.imageData + '">';
    }).join("");
    var n = leg.length, idx = [0, Math.floor(n * 0.33), Math.floor(n * 0.66), n - 1];
    var ticks = idx.map(function (i) { return '<span>' + esc(lb(leg[i])) + '</span>'; }).join("");
    el.innerHTML = '<div class="pk-title">Precip (in)</div><div class="pk-ramp">' + ramp +
      '</div><div class="pk-scale">' + ticks + '</div>';
  }).catch(function () { el.innerHTML = '<div class="pk-title">Precip (in)</div>'; });
}

/* ===== optional enhancement server (ClassicRadarServer) =====
   Fully optional: the site probes /health at boot (saved URL first, then same-origin — the
   server can host this site itself). When up, data paths PREFER the server (slimmed alerts,
   AWC METAR, MRMS severe grids, 24-h loop) and every one falls back to the keyless source
   on any failure, so a dead/unreachable server just means the site behaves as before. */
var SRV = { url: "", up: false, mrms: [], fails: 0 };
var SRV_KEY = "classicRadar.server.v1";
function srvSavedUrl() { try { return localStorage.getItem(SRV_KEY) || ""; } catch (e) { return ""; } }
function srvSaveUrl(u) { try { localStorage.setItem(SRV_KEY, u); } catch (e) {} }
function srvProbe(url, cb) {
  var done = false;
  var t = setTimeout(function () { if (!done) { done = true; cb(null); } }, 2500);
  fetch(url + "/health").then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { if (!done) { done = true; clearTimeout(t); cb(j && j.ok ? j : null); } })
    .catch(function () { if (!done) { done = true; clearTimeout(t); cb(null); } });
}
/* one-line inventory of what the server is currently providing (badge tooltip + status) */
function srvCapsSummary() {
  var parts = ["slim alerts", SRV.synoptic ? "Synoptic mesonet obs" : "aviation METARs",
               "24-h radar+satellite loops"];
  if (SRV.mrms.length) parts.push("MRMS " + SRV.mrms.map(function (p) {
    return p.id + (p.valid ? " " + p.valid.slice(11, 16) + "Z" : "");
  }).join("/"));
  return parts.join(" · ");
}
function srvSetState(url, health) {
  var wasUp = SRV.up;
  SRV.url = url; SRV.up = !!health; SRV.fails = 0;
  SRV.mrms = (health && health.caps && health.caps.mrms) || [];
  SRV.synoptic = !!(health && health.caps && health.caps.synoptic);
  var badge = document.getElementById("srvbadge");
  if (badge) {
    badge.style.display = SRV.up ? "" : "none";
    badge.title = SRV.up ? "Server-provided: " + srvCapsSummary() : "";
  }
  // server-only options stay VISIBLE either way — green ◆ when live, grayed when not —
  // so it's always clear what enhanced mode adds
  var og = document.getElementById("srv-products");
  if (og) og.label = SRV.up ? "Severe weather — ◆ server" : "Severe weather — needs server";
  var fg = document.getElementById("srv-frames");
  if (fg) fg.label = SRV.up ? "Archive loop — ◆ server" : "Archive loop — needs server";
  [].forEach.call(document.querySelectorAll("option.srvopt"), function (o) { o.disabled = !SRV.up; });
  var mt = document.getElementById("tag-metar");
  if (mt) {
    mt.textContent = SRV.up ? (SRV.synoptic ? "◆ Synoptic" : "◆ AWC") : "";
    mt.title = SRV.up ? (SRV.synoptic ? "Dense mesonet obs (Synoptic) via the enhancement server"
                                      : "Obs from aviationweather.gov via the enhancement server") : "";
  }
  var st = document.getElementById("server-status");
  if (st) {
    st.textContent = SRV.up ? "◆ Connected: " + url + " — " + srvCapsSummary()
      : (url ? "Server unreachable — running keyless." : "No server configured — running keyless.");
    st.className = SRV.up ? "hint srv-on" : "hint";
  }
  var atab = P("tab-alerts");        // flip the tab's ◆ immediately, not on the next render
  if (atab) atab.textContent = atab.textContent.replace(" ◆", "") + (SRV.up ? " ◆" : "");
  // reflectivity products: the loop source depends on the server — refresh the note, and on a
  // down->up transition swap the (boot-raced) RainViewer frames for crisp server archive frames
  var prodSel = document.getElementById("product");
  if (optSrc(prodSel) === "rv") {
    var pn = document.getElementById("prodnote");
    if (pn) pn.textContent = rvNote();
    if (SRV.up && !wasUp) loadRainViewer();      // loopReq guard discards any in-flight stale load
  }
  if (!SRV.up) {
    // if a server-only selection is active, drop back to the keyless equivalents
    var prod = document.getElementById("product");
    if (optSrc(prod) === "mrms") { prod.value = "N0B"; applyProduct(); }
    var fr = document.getElementById("frames");
    if (fr.value.charAt(0) === "s") { fr.value = "24"; }
  }
}
function srvFail() {
  if (!SRV.up) return;
  if (++SRV.fails >= 2) { srvSetState(SRV.url, null); }       // degrade; re-probe timer may recover it
}
function srvInit() {
  var cands = [];
  var saved = srvSavedUrl();
  if (saved) cands.push(saved.replace(/\/+$/, ""));
  if (/^https?:/.test(location.protocol)) cands.push(location.origin);   // server hosting this site
  (function next(i) {
    if (i >= cands.length) { srvSetState(saved, null); return; }
    srvProbe(cands[i], function (h) { if (h) srvSetState(cands[i], h); else next(i + 1); });
  })(0);
}
setInterval(function () {          // recover a configured server that comes back (or boots later)
  if (SRV.up) { srvProbe(SRV.url, function (h) { if (!h) srvFail(); else { SRV.fails = 0; SRV.mrms = (h.caps && h.caps.mrms) || SRV.mrms; } }); return; }
  var saved = srvSavedUrl();
  var cand = saved ? saved.replace(/\/+$/, "") : (/^https?:/.test(location.protocol) ? location.origin : "");
  if (cand) srvProbe(cand, function (h) { if (h) srvSetState(cand, h); });
}, 300000);

/* ---- MRMS severe-weather grids (server-only product) ---- */
var mrmsLayer = null;
function clearMrms() { if (mrmsLayer) { map.removeLayer(mrmsLayer); mrmsLayer = null; } clearPrecipKey(); }
function mrmsMeta(id) {
  for (var i = 0; i < SRV.mrms.length; i++) if (SRV.mrms[i].id === id) return SRV.mrms[i];
  return null;
}
function showMrms(id) {
  clearMrms();
  if (!SRV.up) return;
  var meta = mrmsMeta(id);
  mrmsLayer = attachRetry(L.tileLayer(SRV.url + "/tiles/mrms/" + id + "/{z}/{x}/{y}.png?v=" +
    encodeURIComponent((meta && meta.valid) || ""), { pane:"radar", opacity:radarOpacity(),
    maxZoom:18, maxNativeZoom:9, noWrap:true, attribution:"MRMS &copy; NOAA/NSSL via enhancement server" }),
    "MRMS " + id).addTo(map);
  showMrmsKey(meta);
  document.getElementById("stamp").textContent = meta && meta.valid ? "MRMS " + meta.valid.slice(11, 16) + "Z" : "MRMS";
}
function showMrmsKey(meta) {
  var el = document.getElementById("precipkey");
  if (!el || !meta || !meta.legend) return;
  var ramp = meta.legend.map(function (e) {
    return '<span class="pk-box" title="' + esc(e.v) + '" style="background:' + esc(e.c) + '"></span>';
  }).join("");
  var l = meta.legend, idx = [0, Math.floor(l.length / 2), l.length - 1];
  var ticks = idx.map(function (i) { return "<span>" + esc(l[i].v) + "</span>"; }).join("");
  el.innerHTML = '<div class="pk-title">' + esc(meta.units) + '</div><div class="pk-ramp">' + ramp +
    '</div><div class="pk-scale">' + ticks + "</div>";
  el.style.display = "block";
}
/* refresh the MRMS product list (valid times move every ~2 min) then re-point the layer */
function refreshMrms(id) {
  if (!SRV.up) return;
  fetch(SRV.url + "/api/mrms").then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
    if (j && j.products) SRV.mrms = j.products;
    if (currentProductSrc() === "mrms") showMrms(id);
  }).catch(function () { srvFail(); });
}

function clearFrames() {
  buffers.forEach(function (l) { map.removeLayer(l); });
  buffers = []; frontBuf = 0;
  frameUrls = []; frameTimes = [];
}

/* RainViewer is only a ~2 km mosaic (native z7), so it turns to coarse blocks when zoomed
   in. IEM is crisp to z12. Auto-show the crisp IEM layer (on top) once zoomed past IEM_ZOOM
   for reflectivity products; the manual "IEM true-dBZ" checkbox forces it on at any zoom. */
var IEM_ZOOM = 9;
function currentProductSrc() {
  var p = document.getElementById("product");
  return p.options[p.selectedIndex].getAttribute("data-src");
}
function syncIem() {
  if (srvActive) { showIem(false); return; }             // single-radar overlay owns the radar layer
  var manual = document.getElementById("c-iem").checked;
  if (currentProductSrc() !== "rv") { showIem(manual); return; }
  showIem(manual || !usingFrames);      // reliable IEM base whenever not actively looping
}
function isComposite() {
  var p = document.getElementById("product"), o = p.options[p.selectedIndex];
  return !!o && o.value === "NCR";
}
/* Reflectivity "still": IEM n0q base reflectivity for the Base product, NCEP MRMS composite
   reflectivity for the Composite product — so the two are genuinely different data, not just
   a color swap. Keeps a single active still; swaps type when the product changes. */
function showIem(on) {
  var comp = isComposite();
  if (compLayer && (!comp || !on)) { map.removeLayer(compLayer); compLayer = null; }
  if (iemLayer && (comp || !on)) { map.removeLayer(iemLayer); iemLayer = null; }
  if (!on) return;
  if (comp && !compLayer) {
    compLayer = attachRetry(L.tileLayer.wms(MRMS_CREF_URL, { layers:"conus:conus_cref_qcd",
      format:"image/png", transparent:true, version:"1.1.1", pane:"radar", opacity:radarOpacity(),
      maxZoom:18, attribution:"Composite reflectivity &copy; NOAA/NCEP MRMS" }), "MRMS composite reflectivity").addTo(map);
  } else if (!comp && !iemLayer) {
    iemLayer = attachRetry(L.tileLayer(IEM_URL, { pane:"radar", opacity:radarOpacity(), maxZoom:18, maxNativeZoom:12,
      noWrap:true, zIndex:20, attribution:"Base reflectivity &copy; Iowa Environmental Mesonet" }), "IEM base reflectivity").addTo(map);
  }
}

/* ===== single-radar tilt viewer (click a radar site) =====
   Renders ONE radar's super-res Level III tilt — reflectivity OR velocity — client-side
   using the SAME decode as the 3D view (Level3.fetchTilt), as a georeferenced canvas
   image overlay. A top-right toolset (#srvtool) slides through the 4 tilts, toggles the
   product, and closes back to the national composite. Single-radar by nature: velocity is
   radial (green=toward/red=away); reflectivity is this site's own base scan. */
var srvOverlay = null, srvActive = false;
var srv = { site: null, mode: "refl", tilt: 0, elevs: [] };
var SRV_MAX_KM = 230;
var SRV_PRODUCTS = {
  refl: { codes: ["N0B","N1B","N2B","N3B"], label: "Reflectivity",
    keep: function (L) { return L >= 2 && (0.5 * L - 33) >= 5; },         // dBZ floor 5
    color: function (L) { return dbzColor(0.5 * L - 33); } },
  vel:  { codes: ["N0G","N1G","N2G","N3G"], label: "Velocity",
    keep: function (L) { return L >= 2 && L !== 255; },                   // 0 below-thr, 1 range-folded, 255 no-data
    color: function (L) { return velColor((L - 129) * 0.5); } },
  cc:   { codes: ["N0C","N1C","N2C","N3C"], label: "Corr Coef",           // CC = 0.2 + (L-2)*0.00336, 0.2..1.05
    keep: function (L) { return L >= 2; },
    color: function (L) { return ccColor(0.2 + (L - 2) * 0.003360); } },
  zdr:  { codes: ["N0X","N1X","N2X","N3X"], label: "Diff Refl",           // ZDR dB = (L-2)*0.0625 - 7.875
    keep: function (L) { return L >= 2; },
    color: function (L) { return zdrColor((L - 2) * 0.0625 - 7.875); } }
};
function ccColor(v) {   // correlation coefficient: <0.8 non-met (red) .. ~0.97 mixed .. >=0.98 uniform precip (blue)
  if (v >= 0.98) return "rgb(20,90,200)";
  if (v >= 0.95) return "rgb(30,160,90)";
  if (v >= 0.90) return "rgb(210,200,40)";
  if (v >= 0.80) return "rgb(230,130,30)";
  return "rgb(210,40,40)";
}
function zdrColor(v) {  // differential reflectivity (dB): <=0 gray/blue, small+ green, large+ (big drops/rain) red
  if (v <= 0) return "rgb(120,120,150)";
  if (v < 1) return "rgb(60,150,90)";
  if (v < 2) return "rgb(210,200,40)";
  if (v < 4) return "rgb(230,130,30)";
  return "rgb(210,40,40)";
}

function velColor(v) {                                   // matches the 3D velocity ramp
  var a = Math.min(1, Math.abs(v) / 35);
  return v < 0
    ? "rgb(26," + Math.round((0.35 + 0.65 * a) * 255) + ",77)"    // inbound  -> green
    : "rgb(" + Math.round((0.35 + 0.65 * a) * 255) + ",31,31)";   // outbound -> red
}
function dbzColor(v) {                                   // NWS ramp (DBZ_RAMP) -> rgb()
  var hex = DBZ_RAMP[0][1];
  for (var i = 0; i < DBZ_RAMP.length; i++) if (v >= DBZ_RAMP[i][0]) hex = DBZ_RAMP[i][1];
  hex = hex.replace("#", "");
  return "rgb(" + parseInt(hex.substr(0,2),16) + "," + parseInt(hex.substr(2,2),16) + "," + parseInt(hex.substr(4,2),16) + ")";
}

function openSingleRadar(s, mode) {
  srv.site = s; srv.mode = SRV_PRODUCTS[mode] ? mode : "refl"; srv.tilt = 0; srv.elevs = [];
  buildSrvTool();
  map.setView([s.lat, s.lon], Math.min(Math.max(map.getZoom(), 7), 9));   // regional view on the radar
  srvLoadTilt();
}

function srvLoadTilt() {
  var s = srv.site, p = SRV_PRODUCTS[srv.mode], code = p.codes[srv.tilt];
  setSrvStatus("Loading " + p.label.toLowerCase() + " tilt " + (srv.tilt + 1) + "…");
  Level3.fetchTilt(Level3.site3(s.id), code).then(function (t) {
    if (srv.site !== s || SRV_PRODUCTS[srv.mode].codes[srv.tilt] !== code) return;   // superseded by a newer click
    if (!t || !t.radials || !t.radials.length) { setSrvStatus("no data for tilt " + (srv.tilt + 1)); return; }
    srv.elevs[srv.tilt] = t.elevation;
    renderTilt(t);
    setSrvStatus("");
    updateSrvLabels();
  }).catch(function (e) { setSrvStatus("failed: " + e.message); });
}

function renderTilt(t) {
  var p = SRV_PRODUCTS[srv.mode];
  var lat = t.radarLat, lon = t.radarLon, gk = t.gateKm;
  var maxKm = Math.min(t.nbins * gk, SRV_MAX_KM);
  var W = 1200, H = 1200, cx = W / 2, cy = H / 2, pxPerKm = (W / 2) / maxKm;
  var cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  var ctx = cv.getContext("2d");
  ctx.lineWidth = gk * pxPerKm + 0.8;                    // constant: one gate's radial depth
  var maxG = Math.floor(maxKm / gk), D = Math.PI / 180, hw = 0.32 * D;   // half a 0.5° radial (slight overlap)
  t.radials.forEach(function (r) {
    // canvas angle = az - 90° (az is clockwise-from-north; north-up canvas maps it exactly)
    var a = (r.az - 90) * D, a0 = a - hw, a1 = a + hw, lv = r.levels, n = Math.min(lv.length, maxG);
    for (var g = 0; g < n; g++) {
      var L = lv[g];
      if (!p.keep(L)) continue;
      ctx.strokeStyle = p.color(L);
      var rp = (g + 0.5) * gk * pxPerKm;
      ctx.beginPath(); ctx.arc(cx, cy, rp, a0, a1); ctx.stroke();
    }
  });
  var dLat = maxKm / 111.32, dLon = maxKm / (111.32 * Math.cos(lat * Math.PI / 180));
  var bounds = [[lat - dLat, lon - dLon], [lat + dLat, lon + dLon]];
  if (srvOverlay) { map.removeLayer(srvOverlay); srvOverlay = null; }
  srvActive = true;
  showIem(false);                                        // the single-radar overlay owns the radar layer
  if (usingFrames) buffers.forEach(function (l) { l.setOpacity(0); });
  srvOverlay = L.imageOverlay(cv.toDataURL("image/png"), bounds,
    { pane: "velocity", opacity: radarOpacity(), interactive: false }).addTo(map);
}

function closeSingleRadar(restore) {
  if (srvOverlay) { map.removeLayer(srvOverlay); srvOverlay = null; }
  srvActive = false; srv.site = null;
  var tl = document.getElementById("srvtool"); if (tl) tl.style.display = "none";
  var lg = document.getElementById("legend"); if (lg) lg.style.display = "";
  if (restore !== false) syncIem();                      // back to the national composite
}

/* ---- top-right toolset ---- */
function buildSrvTool() {
  var tl = document.getElementById("srvtool"); if (!tl) return;
  tl.innerHTML =
    '<div class="srv-hd"><b id="srv-site"></b><button id="srv-close" title="Return to composite">&times;</button></div>' +
    '<div class="srv-mode"><select id="srv-mode">' +
      '<option value="refl">Reflectivity</option><option value="vel">Velocity</option>' +
      '<option value="cc">Corr Coef (CC)</option><option value="zdr">Diff Refl (ZDR)</option>' +
    '</select></div>' +
    '<div class="srv-body">' +
      '<div class="srv-tiltcol"><input id="srv-tilt" type="range" min="0" max="3" step="1" value="0" orient="vertical"><span class="srv-cap">tilt</span></div>' +
      '<div class="srv-read"><div id="srv-elev" class="srv-elev">--</div><div id="srv-tnum" class="srv-sub">1/4</div><div id="srv-legend" class="srv-legend"></div></div>' +
    '</div>' +
    '<div id="srv-status" class="srv-status" style="display:none"></div>';
  tl.style.display = "block";
  document.getElementById("srv-close").onclick = function () { closeSingleRadar(true); };
  document.getElementById("srv-mode").onchange = function () { setSrvMode(this.value); };
  var tilt = document.getElementById("srv-tilt");
  tilt.value = srv.tilt;
  tilt.oninput = function () { srv.tilt = parseInt(this.value, 10); updateSrvLabels(); srvLoadTilt(); };
  updateSrvLabels();
}
function setSrvMode(m) {
  if (srv.mode === m || !srv.site) return;
  srv.mode = m; srv.elevs = [];
  updateSrvLabels(); srvLoadTilt();
}
var SRV_LEGENDS = {
  refl: '<span class="lk" style="background:#0300f4"></span>15<span class="lk" style="background:#02fd02"></span>25' +
        '<span class="lk" style="background:#fdf802"></span>40<span class="lk" style="background:#fd0000"></span>55+',
  vel:  '<span class="lk vin"></span>toward<br><span class="lk vout"></span>away',
  cc:   '<span class="lk" style="background:rgb(210,40,40)"></span>&lt;0.8<span class="lk" style="background:rgb(210,200,40)"></span>0.9' +
        '<span class="lk" style="background:rgb(20,90,200)"></span>&ge;0.98',
  zdr:  '<span class="lk" style="background:rgb(120,120,150)"></span>&le;0<span class="lk" style="background:rgb(60,150,90)"></span>1' +
        '<span class="lk" style="background:rgb(210,40,40)"></span>4+&nbsp;dB'
};
function updateSrvLabels() {
  if (!srv.site) return;
  var el = document.getElementById("srv-site"); if (el) el.textContent = srv.site.id;
  document.getElementById("srv-mode").value = srv.mode;
  document.getElementById("srv-tilt").value = srv.tilt;
  document.getElementById("srv-tnum").textContent = (srv.tilt + 1) + "/4";
  var e = srv.elevs[srv.tilt];
  document.getElementById("srv-elev").textContent = (e != null ? e.toFixed(1) + "°" : "…");
  document.getElementById("srv-legend").innerHTML = SRV_LEGENDS[srv.mode] || "";
  var lg = document.getElementById("legend");             // dBZ scale only makes sense for reflectivity
  if (lg) lg.style.display = (srv.mode === "refl") ? "" : "none";
}
function setSrvStatus(m) {
  var e = document.getElementById("srv-status"); if (!e) return;
  e.textContent = m || ""; e.style.display = m ? "block" : "none";
}

/* --- RainViewer: fetch frame catalog, build animated (historical) tile layers.
   RainViewer serves ~2 h of past frames globally with no key and no local storage —
   the app pulls them on demand, so nothing needs to be saved server-side. --- */
function currentScheme() {
  var opt = document.getElementById("product");
  var s = opt.options[opt.selectedIndex].getAttribute("data-scheme");
  return s || "6";
}
/* TWO layers, double-buffered: the next frame preloads on the hidden buffer, then we
   swap by opacity -> instant, no clearing/strobe. Only ~2 frames load at once. */
function makeBuffers(maxNative, attribution, label) {
  if (!frameUrls.length) return;
  var lastUrl = frameUrls[frameUrls.length - 1];
  for (var bi = 0; bi < 2; bi++) {
    var lyr = attachRetry(L.tileLayer(lastUrl, { pane:"radar", opacity:0, maxZoom:18,
      maxNativeZoom:maxNative, noWrap:true, attribution:attribution }), label).addTo(map);
    lyr._crFrame = frameUrls.length - 1;
    buffers.push(lyr);
  }
}

var loopReq = 0;   // stale-load guard: only the NEWEST loop request may install frames

/* frames-select value -> {h, step, take} for a product with a given base cadence */
function loopSpec(baseStep) {
  var fsel = document.getElementById("frames").value;
  if (fsel === "s3h") return { h: 3, step: baseStep <= 5 ? 5 : baseStep };
  if (fsel === "s6h") return { h: 6, step: baseStep <= 10 ? 10 : baseStep };
  if (fsel === "s24h") return { h: 24, step: baseStep <= 30 ? 30 : 60 };
  var n = parseInt(fsel, 10) || 12;
  var step = Math.max(baseStep, 10);
  return { h: Math.max(1, Math.ceil(n * step / 60)), step: step, take: n };
}

/* PLAY loop dispatcher — every animatable product routes through here */
function loadRainViewer() {
  var src = currentProductSrc();
  if (src === "sat") return loadSatLoop();
  if (src === "mrms") return SRV.up ? loadMrmsLoop() : Promise.resolve(false);
  // ---- reflectivity ----
  var fsel = document.getElementById("frames").value;
  if (fsel.charAt(0) === "s" && !SRV.up) {
    document.getElementById("frames").value = "24";          // server gone -> RainViewer fallback
    fsel = "24";
  }
  // enhanced: every loop (plain N-frame included) comes from the server's IEM archive
  // (native z12, same crispness as the live still) instead of RainViewer's z7 ~2 km mosaic.
  if (SRV.up) return loadServerLoop(loopSpec(5));
  return loadRvDirect(parseInt(fsel, 10));
}
function loadRvDirect(n) {
  var req = ++loopReq;
  var scheme = currentScheme();
  return fetch("https://api.rainviewer.com/public/weather-maps.json")
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (req !== loopReq) return false;   // a newer loop load superseded this one
      clearFrames();
      var past = (j.radar && j.radar.past) || [];
      var use = past.slice(Math.max(0, past.length - n));
      use.forEach(function (f) {
        frameUrls.push(j.host + f.path + "/256/{z}/{x}/{y}/" + scheme + "/1_1.png");
        frameTimes.push(f.time);
      });
      // RainViewer's mosaic is native z7 -> clamp + upscale
      makeBuffers(7, "Radar &copy; RainViewer", "RainViewer loop");
      curFrame = frameUrls.length - 1;
      wireScrub();
      goLive();                    // default to the reliable IEM current scan; PLAY switches to the loop
      return true;
    });
}

/* Long loops from the enhancement server's rolling 24-h IEM-archive tile store.
   Frames are real 5-min USCOMP N0Q scans (native z12 — far crisper than RainViewer). */
function tsToUnix(ts) {   // "YYYYMMDDHHMM" (UTC) -> unix seconds
  return Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8), +ts.slice(8, 10), +ts.slice(10, 12)) / 1000;
}
function unixToTs(secs) { // unix seconds -> "YYYYMMDDHHMM" (UTC)
  var d = new Date(secs * 1000);
  return "" + d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) +
    pad(d.getUTCHours()) + pad(d.getUTCMinutes());
}

/* ---- satellite animation: GIBS GOES layers accept an ISO time in the WMTS path (10-min
   imagery, days of history). Enhanced = the server's cached copies; keyless = GIBS direct —
   satellite loops work even on the plain GitHub Pages copy. ---- */
function loadSatLoop() {
  var req = ++loopReq;
  var sel = document.getElementById("product");
  var kind = sel.options[sel.selectedIndex].getAttribute("data-sat");
  var g = GIBS[kind];
  if (!g) return Promise.resolve(false);
  var spec = loopSpec(10);
  // newest imagery runs ~25-40 min behind realtime; frames are 10-min aligned
  var newest = Math.floor((Date.now() / 1000 - 2400) / 600) * 600;
  var list = [];
  for (var t = newest - spec.h * 3600; t <= newest; t += spec.step * 60) list.push(t);
  if (spec.take && list.length > spec.take) list = list.slice(-spec.take);
  clearFrames();
  list.forEach(function (secs) {
    var ts = unixToTs(secs);
    frameUrls.push(SRV.up
      ? SRV.url + "/tiles/" + kind + "/" + ts + "/{z}/{x}/{y}.png"
      : g.url.replace("/default/default/", "/default/" + TS_ISO(ts) + "/"));
    frameTimes.push(secs);
  });
  if (req !== loopReq) return Promise.resolve(false);
  makeBuffers(g.maxNative, "Satellite &copy; NASA GIBS / NOAA GOES-East", "GOES loop");
  curFrame = frameUrls.length - 1;
  wireScrub();
  goLive();
  return Promise.resolve(true);
}
function TS_ISO(ts) {
  return ts.slice(0, 4) + "-" + ts.slice(4, 6) + "-" + ts.slice(6, 8) + "T" +
    ts.slice(8, 10) + ":" + ts.slice(10, 12) + ":00Z";
}

/* ---- MRMS product animation (enhanced only): the server keeps 24 h of source frames and
   renders historical tiles on demand. ---- */
function loadMrmsLoop() {
  var req = ++loopReq;
  var sel = document.getElementById("product");
  var id = sel.options[sel.selectedIndex].getAttribute("data-mrms");
  var spec = loopSpec(10);
  return fetch(SRV.url + "/api/frames?product=" + id + "&hours=" + spec.h + "&step=" + spec.step)
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (j) {
      if (req !== loopReq) return false;
      clearFrames();
      var list = j.frames || [];
      if (spec.take && list.length > spec.take) list = list.slice(-spec.take);
      list.forEach(function (ts) {
        frameUrls.push(SRV.url + "/tiles/mrms/" + id + "/at/" + ts + "/{z}/{x}/{y}.png");
        frameTimes.push(tsToUnix(ts));
      });
      makeBuffers(9, "MRMS &copy; NOAA/NSSL via enhancement server", "MRMS loop");
      curFrame = frameUrls.length - 1;
      wireScrub();
      goLive();
      return true;
    })
    .catch(function () { srvFail(); return false; });
}
function loadServerLoop(conf) {
  var req = ++loopReq;
  return fetch(SRV.url + "/api/frames?hours=" + conf.h + "&step=" + conf.step)
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (j) {
      if (req !== loopReq) return false;   // a newer loop load superseded this one
      clearFrames();
      var list = j.frames || [];
      if (conf.take && list.length > conf.take) list = list.slice(-conf.take);
      list.forEach(function (ts) {
        frameUrls.push(SRV.url + "/tiles/n0q/" + ts + "/{z}/{x}/{y}.png");
        frameTimes.push(tsToUnix(ts));
      });
      makeBuffers(12, "Radar archive &copy; IEM via enhancement server", "Server loop");
      curFrame = frameUrls.length - 1;
      wireScrub();
      goLive();
      return true;
    })
    .catch(function () {
      // fall straight to RainViewer (NOT loadRainViewer, which could re-enter this path)
      srvFail();
      if (conf.take) return loadRvDirect(conf.take);
      document.getElementById("frames").value = "24";
      return loadRvDirect(24);
    });
}

var usingFrames = false;   // true while showing an animation loop; false = the "live" still

/* the current product's still layer, hidden while its animation frames are up */
function setStillVisible(on) {
  var src = currentProductSrc();
  if (src === "rv") showIem(on);
  else if (src === "sat" && satLayer) satLayer.setOpacity(on ? radarOpacity() : 0);
  else if (src === "mrms" && mrmsLayer) mrmsLayer.setOpacity(on ? radarOpacity() : 0);
}
function liveStampText() {
  var src = currentProductSrc();
  return src === "sat" ? "GOES latest" : src === "mrms" ? "MRMS latest" : "IEM current";
}

/* return to the current still (every animatable product) */
function goLive() {
  if (srvActive) closeSingleRadar(false);                // LIVE returns to the composite
  usingFrames = false;
  buffers.forEach(function (l) { l.setOpacity(0); });
  setStillVisible(true);
  document.getElementById("stamp").textContent = liveStampText();
  document.getElementById("frameidx").textContent = "live";
  var s = document.getElementById("scrub"); if (s) s.value = s.max;
}

function showFrame(i) {
  if (!frameUrls.length || buffers.length < 2) return;
  usingFrames = true;
  setStillVisible(false);         // hide the still while an animation frame is up
  var n = frameUrls.length;
  curFrame = (i + n) % n;
  var front = buffers[frontBuf], back = buffers[1 - frontBuf];
  if (front._crFrame === curFrame) {
    front.setOpacity(radarOpacity());            // already the visible frame
  } else {
    if (back._crFrame !== curFrame) { back.setUrl(frameUrls[curFrame]); back._crFrame = curFrame; }
    back.setOpacity(radarOpacity());             // reveal the (pre)loaded buffer, then hide the old
    front.setOpacity(0);
    frontBuf = 1 - frontBuf;
  }
  var t = new Date(frameTimes[curFrame] * 1000);
  document.getElementById("stamp").textContent = fmtStamp(t);
  document.getElementById("scrub").value = curFrame;
  document.getElementById("frameidx").textContent = (curFrame + 1) + "/" + n;
  // preload the NEXT frame onto the now-hidden buffer so the next tick swaps instantly
  var nb = buffers[1 - frontBuf], nf = (curFrame + 1) % n;
  if (nb._crFrame !== nf) { nb.setUrl(frameUrls[nf]); nb._crFrame = nf; }
}
function wireScrub() {
  var s = document.getElementById("scrub");
  s.max = Math.max(0, frameUrls.length - 1);
  s.value = curFrame;
}

function tick() {
  if (curFrame === frameUrls.length - 1 && dwellLeft > 0) { dwellLeft--; return; }
  var next = curFrame + 1;
  if (next >= frameUrls.length) { next = 0; dwellLeft = parseInt(document.getElementById("dwell").value, 10) - 1; }
  showFrame(next);
}
function play() {
  if (!frameUrls.length) return;
  playing = true;
  showFrame(curFrame);           // switch from IEM-live to the animation frames
  document.getElementById("pp").innerHTML = "&#10073;&#10073; PAUSE";
  clearInterval(timer);
  timer = setInterval(tick, parseInt(document.getElementById("speed").value, 10));
}
function pause() {
  playing = false;
  document.getElementById("pp").innerHTML = "&#9654; PLAY";
  clearInterval(timer);
}

/* reflectivity-product note: written by applyProduct AND rewritten when the server
   state changes, since the loop source (server archive vs RainViewer) depends on it */
function rvNote() {
  var sel = document.getElementById("product");
  var opt = sel.options[sel.selectedIndex];
  var stillName = (opt.value === "NCR") ? "MRMS composite reflectivity (column-max)" : "IEM base reflectivity (0.5° tilt)";
  return opt.text.replace(/&deg;/g, "°") +
    " — current " + stillName + " still. Press PLAY for the loop (" +
    (SRV.up ? "◆ crisp IEM archive frames via the server" : "RainViewer ~2 h, coarser than the still") +
    "); ◉ LIVE returns to the current still.";
}

/* --- product switch: reflectivity products animate the RainViewer loop;
   the crisp IEM true-dBZ still is a separate toggle (c-iem). --- */
function applyProduct() {
  var sel = document.getElementById("product");
  var opt = sel.options[sel.selectedIndex];
  var src = opt.getAttribute("data-src");
  var note = document.getElementById("prodnote");
  pause();
  if (srvActive) closeSingleRadar(false);                // changing product drops the single-radar overlay
  clearPrecip(); clearPrecipKey(); clearMrms();          // and any MRMS precip/severe layer + key
  document.getElementById("legend").style.display = (src === "rv") ? "" : "none";  // dBZ scale is refl-only

  if (src === "rv") {
    clearSat();
    setPlaybar(true);
    note.textContent = rvNote();
    loadRainViewer();
  } else if (src === "sat") {
    setPlaybar(true);                            // GOES animates too (GIBS keeps time-stamped history)
    showSat(opt.getAttribute("data-sat"));
    note.textContent = opt.text.replace(/&deg;/g,"°") +
      " — GOES-East (NASA GIBS), ~10-min imagery. Press PLAY to animate" +
      (SRV.up ? " (◆ server-cached frames)" : "") + "; ◉ LIVE returns to the latest scan.";
    document.getElementById("stamp").textContent = "GOES latest";
    loadRainViewer();                            // builds the satellite frame list
  } else if (src === "precip") {
    clearFrames(); clearSat();
    setPlaybar(false);
    showPrecip(opt.getAttribute("data-rule"));
    note.textContent = opt.text.replace(/&deg;/g,"°") +
      " — NOAA/NWS MRMS gauge-corrected QPE (inches). National mosaic, updates ~hourly.";
    document.getElementById("stamp").textContent = "MRMS QPE";
  } else if (src === "mrms") {
    clearSat();
    setPlaybar(SRV.up);
    var mid = opt.getAttribute("data-mrms");
    if (SRV.up) {
      refreshMrms(mid);            // re-reads valid times, then draws the layer
      showMrms(mid);
      note.textContent = opt.text + " — MRMS national grid decoded by your enhancement server " +
        "(updates ~2 min). Press PLAY to animate the last hours; ◉ LIVE returns to latest.";
      loadRainViewer();            // builds the MRMS frame list
    } else {
      clearFrames();
      note.textContent = "Requires the enhancement server (not connected).";
      document.getElementById("stamp").textContent = "server n/a";
    }
  } else if (src === "d3") {
    // volumetric launcher: reset the map product to reflectivity, open the 3D view
    clearSat();
    var c = map.getCenter();
    var site = nearestSite(c.lat, c.lng);
    note.textContent = "Opening the 3D volumetric view (" + (opt.getAttribute("data-prod") === "vel" ? "velocity" : "reflectivity") + " tilts)…";
    sel.value = "N0B";               // leave the 2D map on base reflectivity
    loadRainViewer(); setPlaybar(true); clearSat();
    if (site) Volume3D.open(Level3.site3(site.id), site.id + " — " + site.name, opt.getAttribute("data-prod"));
  } else {
    clearSat(); clearFrames();
    setPlaybar(false);
    note.textContent = opt.text.replace(/&deg;/g,"°") + " — not available as a national 2D layer.";
    document.getElementById("stamp").textContent = "product n/a";
  }
  syncIem();   // hide auto-IEM for non-reflectivity products (unless manually forced on)
}
function setPlaybar(on) {
  ["live","pp","step-b","step-f","scrub"].forEach(function (id) {
    document.getElementById(id).disabled = !on;
  });
}

/* ============================= SITES ============================= */
var sites = [];
function loadStations() {
  return fetch("https://api.weather.gov/radar/stations?stationType=WSR-88D,TDWR", {
      headers: { "Accept": "application/geo+json" } })
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (j) {
      sites = j.features.map(function (f) {
        var c = f.geometry && f.geometry.coordinates;
        var p = f.properties || {};
        return {
          id: p.id || p.stationIdentifier,
          net: (p.stationType || "").indexOf("TDWR") >= 0 ? "TDWR" : "WSR-88D",
          name: p.name || "",
          lat: c ? c[1] : null,
          lon: c ? c[0] : null
        };
      }).filter(function (s) { return s.lat != null; });
      populateSites();
      setStatus("Loaded " + sites.length + " radar sites from NWS.");
    })
    .catch(function (e) {
      sites = window.FALLBACK_SITES.slice();
      populateSites();
      setStatus("NWS site list unavailable (" + e.message + "); using built-in list of " + sites.length + " sites.");
    });
}

function populateSites() {
  window.CR_SITES = sites;   // expose for the 3D multi-radar gridder (nearby overlapping radars)
  var net = document.getElementById("network").value;
  var q = document.getElementById("findsite").value.trim().toLowerCase();
  var sel = document.getElementById("site");
  var prev = sel.value;
  var list = sites.filter(function (s) {
    if (net !== "ALL" && s.net !== net) return false;
    if (q && (s.id + " " + s.name).toLowerCase().indexOf(q) < 0) return false;
    return true;
  }).sort(function (a, b) { return a.id < b.id ? -1 : 1; });

  sel.innerHTML = "";
  list.forEach(function (s) {
    var o = document.createElement("option");
    o.value = s.id;
    o.textContent = s.id + " — " + s.name;
    sel.appendChild(o);
  });
  if (prev && list.some(function (s) { return s.id === prev; })) sel.value = prev;
  showSiteInfo();
}
function currentSite() {
  var id = document.getElementById("site").value;
  return sites.filter(function (s) { return s.id === id; })[0];
}
function showSiteInfo() {
  var s = currentSite();
  var el = document.getElementById("siteinfo");
  if (!s) { el.innerHTML = "&nbsp;"; return; }
  el.innerHTML = "<b>" + s.id + "</b> (" + s.net + ")<br>" +
    s.lat.toFixed(3) + "°, " + s.lon.toFixed(3) + "°";
}
function centerOnSite() {
  var s = currentSite();
  if (s) map.setView([s.lat, s.lon], Math.max(map.getZoom(), 8));
}

/* ---- radar site icons (click for that radar's dedicated view) ---- */
var siteLayer = L.layerGroup([], { pane:"sites" });
function buildSiteMarkers() {
  siteLayer.clearLayers();
  var net = document.getElementById("network").value;   // ALL / WSR-88D / TDWR filters the map too
  sites.forEach(function (s) {
    if (s.lat == null) return;
    if (net !== "ALL" && s.net !== net) return;
    var m = L.marker([s.lat, s.lon], { pane:"sites", icon: L.divIcon({
      className: "siteicon " + (s.net === "TDWR" ? "tdwr" : "nexrad"),
      iconSize: [11, 11], iconAnchor: [5.5, 5.5], html: '<span class="sdot"></span>' }) });
    m.bindTooltip(s.id + " — " + s.name, { direction: "top", offset: [0, -5] });
    m.on("click", function () { openSitePopup(s); });
    siteLayer.addLayer(m);
  });
  if (document.getElementById("c-sites").checked && !map.hasLayer(siteLayer)) siteLayer.addTo(map);
}
function openSitePopup(s) {
  var html = '<div class="sitepop"><b>' + s.id + '</b> &middot; ' + s.net + '<br>' + s.name + '<br>' +
    s.lat.toFixed(3) + '&deg;, ' + s.lon.toFixed(3) + '&deg;<br>' +
    (s.net === "WSR-88D"
      ? '<button class="sp-single">Open this radar</button><button class="sp-vel">Velocity</button><button class="sp-3d">3D volume</button>'
      : '<button class="sp-go">Center on this radar</button>') + '</div>';
  L.popup({ offset: [0, -4] }).setLatLng([s.lat, s.lon]).setContent(html).openOn(map);
  setTimeout(function () {
    var el = document.querySelector(".sitepop"); if (!el) return;
    var bg = el.querySelector(".sp-go");
    if (bg) bg.onclick = function () { map.closePopup(); selectSite(s); };
    var bs = el.querySelector(".sp-single");     // single-radar tilt viewer, reflectivity
    if (bs) bs.onclick = function () { map.closePopup(); openSingleRadar(s, "refl"); };
    var bv = el.querySelector(".sp-vel");         // ...same viewer, velocity
    if (bv) bv.onclick = function () { map.closePopup(); openSingleRadar(s, "vel"); };
    var b3 = el.querySelector(".sp-3d");
    if (b3) b3.onclick = function () { map.closePopup(); Volume3D.open(Level3.site3(s.id), s.id + " — " + s.name, "refl"); };
  }, 0);
}
function selectSite(s) {
  var sel = document.getElementById("site");
  if (![].some.call(sel.options, function (o) { return o.value === s.id; })) {
    document.getElementById("network").value = "ALL";
    document.getElementById("findsite").value = "";
    populateSites();
  }
  sel.value = s.id;
  showSiteInfo();
  map.setView([s.lat, s.lon], Math.max(map.getZoom(), 9));   // zoom in so its radar detail shows
}

/* =================== WARNINGS -> STORM TABLE =================== */
var WARN_EVENTS = {
  "Tornado Warning": "TOR",
  "Severe Thunderstorm Warning": "SVR",
  "Flash Flood Warning": "FFW",
  "Special Marine Warning": "SMW"
};
var cellMarkers = [];
var cellRefs = {};      // id -> { marker, poly, color, center }
var rowsById = {};
var selectedId = null;

function param(props, key) {
  var p = props.parameters || {};
  return (p[key] && p[key][0]) ? p[key][0] : "";
}
function parseMotion(props) {
  var d = param(props, "eventMotionDescription");   // "...;260DEG;45KT"
  var deg = /(\d{1,3})\s*DEG/i.exec(d);
  var kt  = /(\d{1,3})\s*KT/i.exec(d);
  return {
    deg: deg ? parseInt(deg[1], 10) : null,
    kt:  kt  ? parseInt(kt[1], 10)  : null
  };
}
function compass(bearing) {
  var pts = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return pts[Math.round(bearing / 22.5) % 16];
}
function centroid(geom) {
  if (!geom) return null;
  var ring = geom.type === "Polygon" ? geom.coordinates[0]
           : geom.type === "MultiPolygon" ? geom.coordinates[0][0] : null;
  if (!ring) return null;
  var x = 0, y = 0;
  ring.forEach(function (c) { x += c[0]; y += c[1]; });
  return [y / ring.length, x / ring.length];
}
function geomBBox(geom) {
  var pts = [];
  function collect(a) { if (typeof a[0] === "number") pts.push(a); else a.forEach(collect); }
  if (geom) collect(geom.coordinates);
  if (!pts.length) return null;
  var lons = pts.map(function (p){return p[0];}), lats = pts.map(function (p){return p[1];});
  return L.latLngBounds([Math.min.apply(null,lats), Math.min.apply(null,lons)],
                        [Math.max.apply(null,lats), Math.max.apply(null,lons)]);
}
function cellId(i) {  // A0, B1, ... classic alphanumeric-style labels
  return String.fromCharCode(65 + (i % 26)) + (Math.floor(i / 26));
}

var warnLayer = L.layerGroup([], { pane:"warn" }).addTo(map);
var trackLayer = L.layerGroup([], { pane:"track" }).addTo(map);
var alertLayer = L.layerGroup([], { pane:"alerts" }).addTo(map);      // all in-view alert areas (toggle)
var alertSelLayer = L.layerGroup([], { pane:"warn" }).addTo(map);     // the selected alert, highlighted
var alertHoverLayer = L.layerGroup([], { pane:"warn" }).addTo(map);   // picker hover preview
var topsLayer = L.layerGroup([], { pane:"tops" }).addTo(map);         // storm-top callouts (toggle)
var outlookLayer = L.layerGroup([], { pane:"outlook" }).addTo(map);   // SPC convective outlook (toggle)
var watchesLayer = L.layerGroup([], { pane:"watches" }).addTo(map);   // SPC watch boxes (toggle)
var metarLayer = L.layerGroup([], { pane:"metar" }).addTo(map);       // METAR surface obs (toggle)
var lastL3 = null;

function haversine(a, b, c, d) {
  var R = 6371, dl = (c - a) * Math.PI / 180, dn = (d - b) * Math.PI / 180;
  var x = Math.sin(dl/2)*Math.sin(dl/2) +
    Math.cos(a*Math.PI/180)*Math.cos(c*Math.PI/180)*Math.sin(dn/2)*Math.sin(dn/2);
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
function nearestSite(lat, lon) {
  var best = null, bestKm = Infinity;
  sites.forEach(function (s) {
    if (s.net !== "WSR-88D") return;
    var d = haversine(lat, lon, s.lat, s.lon);
    if (d < bestKm) { bestKm = d; best = s; }
  });
  return best;
}

var WARN_URL = "https://api.weather.gov/alerts/active?status=actual&message_type=alert" +
  "&event=Tornado%20Warning&event=Severe%20Thunderstorm%20Warning" +
  "&event=Flash%20Flood%20Warning&event=Special%20Marine%20Warning";

/* below this zoom we stop fetching Level III entirely. Between here and z7 the storm field is
   drawn SPARSE (only significant / warning-linked / TVS cells + tracks) so it stays readable;
   z7+ fills in. Tracks come from up to MAX_L3_SITES WSR-88D sites nearest the map centre. */
var TRACK_MIN_ZOOM = 5;
var SPARSE_ZOOM = 7;         // below this, show only significant cells/tracks
var MAX_L3_SITES = 5;
var l3Cache = {};   // site3 -> { t, result } (3-min TTL, so panning doesn't refetch)

function sitesInView() {
  var b = map.getBounds().pad(0.1), c = map.getCenter();
  var list = sites.filter(function (s) {
    return s.net === "WSR-88D" &&
      s.lat >= b.getSouth() && s.lat <= b.getNorth() && s.lon >= b.getWest() && s.lon <= b.getEast();
  });
  list.sort(function (a, d) { return haversine(c.lat, c.lng, a.lat, a.lon) - haversine(c.lat, c.lng, d.lat, d.lon); });
  return list.slice(0, MAX_L3_SITES);
}
function fetchNstCached(site3) {
  var e = l3Cache[site3];
  if (e && Date.now() - e.t < 180000) return Promise.resolve(e.result);
  return Level3.fetchStormTrack(site3)
    .then(function (r) { l3Cache[site3] = { t: Date.now(), result: r }; return r; })
    .catch(function () { return null; });
}

function loadStormData() {
  setTableStatus("querying NWS + Level III…");
  loadAlerts();                                   // verbose alerts table (independent, non-blocking)
  var warnP = fetch(WARN_URL, { headers:{ "Accept":"application/geo+json" } })
    .then(function (r) { return r.ok ? r.json() : { features: [] }; })
    .then(function (j) { return j.features || []; })
    .catch(function () { return []; });
  var svs = [];
  if (map.getZoom() >= TRACK_MIN_ZOOM) {
    svs = sitesInView();
    if (!svs.length) { var c = map.getCenter(); var n = nearestSite(c.lat, c.lng); if (n) svs = [n]; }
  }
  var l3P = Promise.all(svs.map(function (s) {
    return fetchNstCached(Level3.site3(s.id)).then(function (r) { return { site: s, result: r }; });
  }));
  return Promise.all([warnP, l3P]).then(function (res) {
    var l3List = res[1].filter(function (x) { return x.result; });
    // fetch Enhanced Echo Tops + Digital VIL only for radars that actually returned cells (cached)
    var eetSites = l3List.filter(function (e) { return e.result.cells && e.result.cells.length; });
    return Promise.all(eetSites.map(function (e) {
      var s3 = Level3.site3(e.site.id);
      return Promise.all([fetchEETCached(s3), fetchDVLCached(s3)]).then(function (ss) {
        return { id: e.site.id, eet: ss[0], dvl: ss[1] };
      });
    })).then(function (samplers) {
      var eetBySite = {}, dvlBySite = {};
      samplers.forEach(function (e) {
        if (e.eet) eetBySite[e.id] = e.eet;
        if (e.dvl) dvlBySite[e.id] = e.dvl;
      });
      renderStorm(res[0], l3List, eetBySite, dvlBySite);
    });
  });
}
var eetCache = {};   // site3 -> { t, sampler } (3-min TTL)
function fetchEETCached(site3) {
  var e = eetCache[site3];
  if (e && Date.now() - e.t < 180000) return Promise.resolve(e.sampler);
  return Level3.fetchEET(site3).then(function (s) { eetCache[site3] = { t: Date.now(), sampler: s }; return s; })
    .catch(function () { return null; });
}
var dvlCache = {};   // site3 -> { t, sampler } (3-min TTL) — Digital VIL, product 134
function fetchDVLCached(site3) {
  var e = dvlCache[site3];
  if (e && Date.now() - e.t < 180000) return Promise.resolve(e.sampler);
  return Level3.fetchDVL(site3).then(function (s) { dvlCache[site3] = { t: Date.now(), sampler: s }; return s; })
    .catch(function () { return null; });
}
var loadWarnings = loadStormData;   // back-compat alias

/* Storm-top callouts, de-cluttered by zoom: place the TALLEST tops first and skip any label
   whose screen box would overlap one already placed — so zooming out keeps only the highest,
   never a pile of overlapping boxes. Re-runs on every pan/zoom (renderStorm) with fresh pixels. */
function drawTopCallouts(rows) {
  topsLayer.clearLayers();
  if (!document.getElementById("c-tops").checked) return;
  var cells = rows.filter(function (r) { return r.center && r.top != null; })
    .sort(function (a, b) { return b.top - a.top; });     // tallest first = highest priority
  var placed = [];
  cells.forEach(function (r) {
    var p = map.latLngToContainerPoint(r.center);
    var w = 34 + String(r.top).length * 7;                // ~ label width in px; label sits up-right of the cell
    var box = { x1: p.x + 4, y1: p.y - 24, x2: p.x + 4 + w, y2: p.y - 8 };
    for (var i = 0; i < placed.length; i++) {
      var b = placed[i];
      if (!(box.x2 < b.x1 || box.x1 > b.x2 || box.y2 < b.y1 || box.y1 > b.y2)) return;   // overlaps -> skip
    }
    placed.push(box);
    L.marker(r.center, { pane:"tops", interactive:false, icon: L.divIcon({
      className:"topcallout", iconSize:[0,0], html:'<span class="topbox">▲' + r.top + 'kft</span>' }) }).addTo(topsLayer);
  });
}

function renderStorm(features, l3List, eetBySite, dvlBySite) {
  eetBySite = eetBySite || {};
  dvlBySite = dvlBySite || {};
  warnLayer.clearLayers();
  trackLayer.clearLayers();
  topsLayer.clearLayers();
  cellMarkers.forEach(function (m){ map.removeLayer(m); });
  cellMarkers = []; rowsById = {}; cellRefs = {}; selectedId = null;
  lastL3 = l3List[0] ? l3List[0].result : null;

  var bounds = map.getBounds().pad(0.15);
  chimeCheck(features, bounds);          // optional chime on a never-seen in-view warning
  var z = map.getZoom();
  var showTracks = z >= TRACK_MIN_ZOOM && document.getElementById("c-tracks").checked;
  // thin tracks progressively as you zoom out so they don't overlap into mush:
  //   z>=9: every track + minute ticks (dots/labels) · z8: every track, thinner, NO ticks
  //   z7: only significant (warning-linked / TVS) tracks, no ticks · below z7: none (data gated)
  var trackTicks = z >= 9;
  var trackAllCells = z >= 8;
  var sparse = z < SPARSE_ZOOM;    // zoomed way out -> only significant cells' markers/tracks
  var rows = [];

  // 1) Level III cells from every in-view radar (only those within the padded view)
  l3List.forEach(function (entry, si) {
    var res = entry.result;
    if (!res || !res.cells) return;
    var eet = eetBySite[entry.site.id];
    var dvl = dvlBySite[entry.site.id];
    res.cells.forEach(function (c) {
      if (c.lat < bounds.getSouth() || c.lat > bounds.getNorth() ||
          c.lon < bounds.getWest() || c.lon > bounds.getEast()) return;
      var top = (eet && c.az != null && c.ran != null) ? eet.sampleTop(c.az, c.ran) : null;
      var vil = (dvl && c.az != null && c.ran != null) ? dvl.sampleVil(c.az, c.ran) : null;
      rows.push({
        key: c.id + "#" + si, id: c.id, site: entry.site.id,
        glyph: "●", cls: "t-cell", threat: "cell", event: "Radar cell · " + entry.site.id,
        hail: null, wind: null, dir: (c.headingToward != null ? compass(c.headingToward) : "—"),
        spd: c.speedKt >= 0 ? c.speedKt : null, top: top, vil: vil,
        area: "", expires: null, center: [c.lat, c.lon], track: c.forecast, tvs: false
      });
    });
  });

  // 2) NWS warnings in view -> merge onto nearest cell (<=40 km) or add own row
  features.forEach(function (f) {
    var props = f.properties || {};
    var code = WARN_EVENTS[props.event];
    if (!code) return;
    var bb = geomBBox(f.geometry);
    if (!bb || !bounds.intersects(bb)) return;
    var cen = centroid(f.geometry);
    var hail = parseFloat(param(props, "maxHailSize")) || null;
    var wind = parseInt(param(props, "maxWindGust"), 10) || null;
    var torDet = param(props, "tornadoDetection");
    var mot = parseMotion(props);
    var color = code === "TOR" ? "#e01f1f" : code === "SVR" ? "#e8a200" : "#1f8a3b";

    var target = null, bestKm = Infinity;
    if (cen) rows.forEach(function (r) {
      if (!r.center) return;
      var d = haversine(cen[0], cen[1], r.center[0], r.center[1]);
      if (d < bestKm) { bestKm = d; target = r; }
    });
    if (!(target && bestKm < 40)) {
      target = { key: "W#" + rows.length, id: cellId(rows.length), center: cen, track: [] };
      rows.push(target);
    }
    if (code === "TOR" || (torDet && /OBSERVED/i.test(torDet))) { target.glyph="▼"; target.cls="t-tor"; target.threat="tvs"; target.tvs=true; }
    else if (code === "SVR") { target.glyph="■"; target.cls="t-hail"; target.threat="hail"; }
    else { target.glyph="◆"; target.cls="t-meso"; target.threat=(code==="FFW"?"flood":"marine"); }
    target.event = props.event.replace(" Warning", " Wrn");
    target.hail = hail; target.wind = wind;
    target.area = (props.areaDesc || "").split(";")[0];
    target.expires = props.expires ? new Date(props.expires) : null;
    if ((target.spd == null || target.dir === "—" || !target.dir) && mot.deg != null) {
      target.dir = compass((mot.deg + 180) % 360); target.spd = mot.kt;
    }
    if (f.geometry) {
      var poly = L.geoJSON(f.geometry, { pane:"warn",
        style:{ color:color, weight:2.5, fill:true, fillColor:color, fillOpacity:0.15, dashArray:"6 4" } })
        .addTo(warnLayer);
      poly.on("click", onAlertAreaClick);      // overlapping warnings -> picker list (from the alerts feed)
      target._poly = poly; target._color = color;
    }
  });

  // 3) markers + forecast tracks + refs
  rows.forEach(function (r) {
    if (!r.glyph) { r.glyph = "●"; r.cls = "t-cell"; r.threat = "cell"; r.event = r.event || "Radar cell"; }
    // zoomed way out (z7), keep only significant (warning-linked / TVS) tracks; radar-only cells drop theirs
    var drawTrack = showTracks && r.track && r.track.length && r.center &&
      (trackAllCells || r.threat !== "cell" || r.tvs);
    if (drawTrack) {
      var tp = [r.center].concat(r.track);
      var lw = trackTicks ? 2 : 1.6;
      L.polyline(tp, { pane:"track", color:"#000", weight:lw + 2, opacity:0.35 }).addTo(trackLayer);
      L.polyline(tp, { pane:"track", color:"#ffd23f", weight:lw, opacity:0.95 }).addTo(trackLayer);
      if (trackTicks) r.track.forEach(function (pt, i) {
        L.circleMarker(pt, { pane:"track", radius:2.6, color:"#ffd23f", weight:1.5,
          fillColor:"#1a1a1a", fillOpacity:1 }).addTo(trackLayer);
        L.marker(pt, { pane:"track", icon: L.divIcon({ className:"trktick",
          html:((i + 1) * 15) + "′", iconSize:[0,0] }) }).addTo(trackLayer);
      });
    }
    var marker = null;
    if (r.center) {
      marker = L.marker(r.center, { pane:"cells", icon: L.divIcon({
        className:"cellmark-wrap", iconSize:[0,0],
        html:'<span class="cellmark ' + r.cls + '">' + r.glyph + " " + r.id + "</span>" }) });
      (function (key) {
        marker.on("click", function(){ selectRow(key); });
        marker.on("mouseover", function(){ hoverCell(key, true); });
        marker.on("mouseout", function(){ hoverCell(key, false); });
      })(r.key);
      cellMarkers.push(marker);
      // zoomed way out, only show significant (warning-linked / TVS) cell markers so it stays readable
      if (document.getElementById("c-cells").checked && (!sparse || r.threat !== "cell" || r.tvs)) marker.addTo(map);
    }
    cellRefs[r.key] = { marker:marker, poly:r._poly || null, color:r._color || "#4a6ea9", center:r.center };
  });

  drawTopCallouts(rows);

  // remember cell tops so the alerts table can show the max echo top inside each alert area
  cellTops = rows.filter(function (r) { return r.top != null && r.center; })
    .map(function (r) { return { lat: r.center[0], lon: r.center[1], top: r.top }; });
  annotateAlertTops();

  buildTable(rows);

  var tr = P("textreadout");
  var texts = l3List.filter(function (e) { return e.result && e.result.rawText && e.result.rawText.trim(); });
  if (texts.length) {
    tr.textContent = texts.map(function (e) {
      return "══ " + e.site.id + "  vol " + e.result.volTime + " ══\n" + e.result.rawText;
    }).join("\n\n");
  } else if (map.getZoom() < TRACK_MIN_ZOOM) {
    tr.textContent = "Zoom in (≥ z" + TRACK_MIN_ZOOM + ") to load Level III storm tracks — they're hidden when zoomed out so they don't overlap.";
  } else {
    tr.textContent = "No Level III storm-track cells in view right now (SCIT isn't tracking discrete cells).\nThe table is populated from live NWS warning tags.";
  }

  var l3n = rows.filter(function (r) { return r.threat === "cell"; }).length;
  var radars = l3List.map(function (e) { return e.site.id; });
  setTableStatus(rows.length + " cell(s) · " + l3n + " Level III" +
    (radars.length ? " (" + radars.join(",") + ")" : "") + " · " + fmtStamp(new Date()).slice(11));
}

function buildTable(rows) {
  var body = P("tablebody");
  if (!rows.length) {
    body.innerHTML = '<div class="empty">No active severe warnings in the current view. ' +
      'Pan to an area of active weather, or press Reload data. ' +
      '(Table is driven by live NWS warning algorithm output.)</div>';
    return;
  }
  var h = '<table class="storm"><thead><tr>' +
    '<th>ID</th><th>Threat</th><th>Event</th><th>Top (kft)</th><th>VIL (kg/m²)</th><th>Max Hail (in)</th>' +
    '<th>Max Wind (kt)</th><th>Dir</th><th>Spd (kt)</th><th>Area</th><th>Expires</th>' +
    '</tr></thead><tbody>';
  rows.forEach(function (r) {
    rowsById[r.key] = r;
    h += '<tr data-key="' + r.key + '">' +
      '<td class="id">' + r.id + '</td>' +
      '<td class="ev"><span class="threat ' + r.cls + '">' + r.glyph + "</span> " + r.threat.toUpperCase() + '</td>' +
      '<td class="ev">' + r.event + '</td>' +
      '<td>' + (r.top != null ? r.top : "—") + '</td>' +
      '<td>' + (r.vil != null ? r.vil : "—") + '</td>' +
      '<td>' + (r.hail != null ? r.hail.toFixed(2) : "—") + '</td>' +
      '<td>' + (r.wind != null ? r.wind : "—") + '</td>' +
      '<td class="dir">' + r.dir + '</td>' +
      '<td>' + (r.spd != null ? r.spd : "—") + '</td>' +
      '<td class="ev">' + r.area + '</td>' +
      '<td>' + (r.expires ? fmtClock(r.expires) : "—") + '</td>' +
      '</tr>';
  });
  h += "</tbody></table>";
  body.innerHTML = h;
  body.querySelectorAll("tr[data-key]").forEach(function (tr) {
    var key = tr.getAttribute("data-key");
    tr.addEventListener("click", function () { selectRow(key); });
    tr.addEventListener("mouseenter", function () { hoverCell(key, true); });
    tr.addEventListener("mouseleave", function () { hoverCell(key, false); });
  });
}
function isMobile() { return window.matchMedia("(max-width: 760px)").matches; }

/* transient highlight of a cell's row + marker on hover (either direction) */
function hoverCell(key, on) {
  var tr = Pq('tr[data-key="' + key + '"]');
  if (tr) tr.classList.toggle("mk-hi", on);
  var ref = cellRefs[key];
  var el = ref && ref.marker && ref.marker.getElement();
  if (el) el.classList.toggle("hi", on);
}

/* persistent selection linking one table row <-> one map cell */
function selectRow(key) {
  selectedId = key;
  panelDoc.querySelectorAll("tr[data-key]").forEach(function (tr) {
    tr.classList.toggle("sel", tr.getAttribute("data-key") === key);
  });
  // reset every marker/polygon, then emphasize the chosen one
  Object.keys(cellRefs).forEach(function (k) {
    var ref = cellRefs[k];
    var el = ref.marker && ref.marker.getElement();
    if (el) el.classList.remove("sel");
    if (ref.poly) ref.poly.setStyle({ weight:2.5, fillOpacity:0.15 });
  });
  var ref = cellRefs[key];
  if (ref) {
    var el = ref.marker && ref.marker.getElement();
    if (el) el.classList.add("sel");
    if (ref.poly) ref.poly.setStyle({ weight:4, fillOpacity:0.38, color:ref.color });
  }
  var r = rowsById[key];
  if (r && r.center) map.flyTo(r.center, Math.max(map.getZoom(), 8), { duration:0.6 });

  var selTr = Pq('tr[data-key="' + key + '"]');
  if (selTr) selTr.scrollIntoView({ block:"nearest" });
  // on a phone the map sits above the table - bring it into view so the ping is seen
  if (isMobile() && !panelWin) document.getElementById("mapwrap").scrollIntoView({ behavior:"smooth", block:"start" });
}

/* ============================= HELPERS ============================= */
function pad(n){ return (n<10?"0":"") + n; }
function fmtStamp(d) {
  return d.getUTCFullYear() + "-" + pad(d.getUTCMonth()+1) + "-" + pad(d.getUTCDate()) + " " +
    pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + "Z";
}
function fmtClock(d) { return pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + "Z"; }
function setStatus(t){ document.getElementById("datastatus").textContent = t; }
function setTableStatus(t){ var e = P("tablestatus"); if (e) e.textContent = t; }

function buildLegend() {
  var g = document.getElementById("legend-grid");
  DBZ_RAMP.forEach(function (p) {
    var d = document.createElement("div");
    d.className = "sw"; d.style.background = p[1];
    d.title = p[0] + " dBZ";
    g.appendChild(d);
  });
}
function startClock() {
  setInterval(function () {
    document.getElementById("clock").textContent = fmtStamp(new Date()).slice(11) +
      " " + fmtStamp(new Date()).slice(0,10);
  }, 1000);
}

/* ============================= EVENTS ============================= */
function panFrac(dx, dy) {
  var s = map.getSize();
  map.panBy([dx * s.x * 0.45, dy * s.y * 0.45]);
}
var PANS = { "pan-n":[0,-1],"pan-s":[0,1],"pan-e":[1,0],"pan-w":[-1,0],
  "pan-ne":[1,-1],"pan-nw":[-1,-1],"pan-se":[1,1],"pan-sw":[-1,1] };
Object.keys(PANS).forEach(function (id) {
  document.getElementById(id).addEventListener("click", function () {
    panFrac(PANS[id][0], PANS[id][1]);
  });
});

/* mobile: collapsible controls drawer */
document.getElementById("menubtn").addEventListener("click", function () {
  document.body.classList.toggle("controls-open");
  setTimeout(function () { map.invalidateSize(); }, 260);
});
window.addEventListener("resize", function () { map.invalidateSize(); });

document.getElementById("network").addEventListener("change", function () { populateSites(); buildSiteMarkers(); });
document.getElementById("findsite").addEventListener("input", populateSites);
document.getElementById("site").addEventListener("change", function () {
  showSiteInfo(); centerOnSite();
  if (isMobile()) {   // close the drawer so the map is visible after picking a site
    document.body.classList.remove("controls-open");
    setTimeout(function () { map.invalidateSize(); }, 260);
  }
});
document.getElementById("recenter").addEventListener("click", centerOnSite);

var myLocMarker = null;
function goToMyLocation(lat, lon, approx, place) {
  if (myLocMarker) map.removeLayer(myLocMarker);
  myLocMarker = L.marker([lat, lon], { pane:"cells", icon: L.divIcon({
    className:"myloc" + (approx ? " approx" : ""), iconSize:[16,16], iconAnchor:[8,8], html:'<span class="mydot"></span>' }) }).addTo(map);
  map.setView([lat, lon], Math.max(map.getZoom(), approx ? 8 : 9));   // loadWarnings picks the in-view radars
  var n = nearestSite(lat, lon);
  loadWarnings();
  if (document.getElementById("c-metar").checked) loadMetar();
  setStatus((approx ? "Approx location" + (place ? " (" + place + ")" : "") + " via IP" : "Located you") +
    (n ? " · nearest radar " + n.id : "") + ".");
}
/* IP-based geolocation fallback (keyless, CORS-open; tries a few providers in order) */
var IP_GEO = [
  { url:"https://ipapi.co/json/", lat:"latitude", lon:"longitude" },
  { url:"https://get.geojs.io/v1/ip/geo.json", lat:"latitude", lon:"longitude" },
  { url:"https://ipwho.is/", lat:"latitude", lon:"longitude" }
];
function ipLocate(i) {
  i = i || 0;
  if (i >= IP_GEO.length) { setStatus("Couldn't determine your location (GPS + IP lookup failed)."); return; }
  var s = IP_GEO[i];
  fetch(s.url).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
    var lat = j && parseFloat(j[s.lat]), lon = j && parseFloat(j[s.lon]);
    if (j && isFinite(lat) && isFinite(lon)) goToMyLocation(lat, lon, true, j.city || j.region || "");
    else ipLocate(i + 1);
  }).catch(function () { ipLocate(i + 1); });
}
document.getElementById("mylocation").addEventListener("click", function () {
  setStatus("Locating…");
  if (!navigator.geolocation) { ipLocate(); return; }   // no GPS API -> straight to IP
  navigator.geolocation.getCurrentPosition(
    function (pos) { goToMyLocation(pos.coords.latitude, pos.coords.longitude, false); },
    function () { setStatus("GPS unavailable — trying IP lookup…"); ipLocate(); },   // denied / timeout / error -> IP
    { enableHighAccuracy:false, timeout:8000, maximumAge:60000 });
});
document.getElementById("view3d").addEventListener("click", function () {
  var c = map.getCenter();
  var site = nearestSite(c.lat, c.lng);
  if (!site) { setStatus("No NEXRAD site near the current view for a 3D volume."); return; }
  Volume3D.open(Level3.site3(site.id), site.id + " — " + site.name);
});
document.getElementById("product").addEventListener("change", applyProduct);
document.getElementById("frames").addEventListener("change", function () {
  var src = currentProductSrc();
  if (src === "rv" || src === "sat" || src === "mrms") loadRainViewer();   // rebuild the active loop
});
document.getElementById("speed").addEventListener("change", function () { if (playing) play(); });

document.getElementById("live").addEventListener("click", function () { pause(); goLive(); });
document.getElementById("pp").addEventListener("click", function () { playing ? pause() : play(); });
document.getElementById("step-f").addEventListener("click", function () { pause(); showFrame(curFrame + 1); });
document.getElementById("step-b").addEventListener("click", function () { pause(); showFrame(curFrame - 1); });
document.getElementById("scrub").addEventListener("input", function () { pause(); showFrame(parseInt(this.value, 10)); });

document.getElementById("opacity").addEventListener("input", function () {
  if (iemLayer) iemLayer.setOpacity(radarOpacity());
  if (compLayer) compLayer.setOpacity(radarOpacity());
  if (satLayer) satLayer.setOpacity(radarOpacity());
  if (usingFrames && buffers.length) buffers[frontBuf].setOpacity(radarOpacity());
  if (srvOverlay) srvOverlay.setOpacity(radarOpacity());
  if (precipLayer) precipLayer.setOpacity(radarOpacity());
  if (mrmsLayer) mrmsLayer.setOpacity(radarOpacity());
});

function toggleLayer(cb, layer) {
  document.getElementById(cb).addEventListener("change", function () {
    if (this.checked) layer.addTo(map); else map.removeLayer(layer);
  });
}
toggleLayer("c-base", layers.base);
toggleLayer("c-county", layers.county);
toggleLayer("c-hwy", layers.hwy);
toggleLayer("c-city", layers.city);
document.getElementById("c-warn").addEventListener("change", function () {
  if (this.checked) warnLayer.addTo(map); else map.removeLayer(warnLayer);
});
document.getElementById("c-cells").addEventListener("change", function () {
  cellMarkers.forEach(function (m) { this.checked ? m.addTo(map) : map.removeLayer(m); }, this);
  document.getElementById("symlegend").style.display = this.checked ? "" : "none";
});
document.getElementById("c-tracks").addEventListener("change", function () {
  if (this.checked) trackLayer.addTo(map); else map.removeLayer(trackLayer);
});
document.getElementById("c-tops").addEventListener("change", function () { loadWarnings(); });
document.getElementById("c-outlook").addEventListener("change", loadOutlook);
document.getElementById("c-watches").addEventListener("change", loadWatches);
document.getElementById("c-metar").addEventListener("change", loadMetar);
document.getElementById("c-iem").addEventListener("change", syncIem);
map.on("zoomend", syncIem);
document.getElementById("c-sites").addEventListener("change", function () {
  if (this.checked) siteLayer.addTo(map); else map.removeLayer(siteLayer);
});

/* storm panel tabs: table <-> raw Level III text */
/* ===================== VERBOSE WEATHER ALERTS ===================== */
/* Every active NWS alert (warnings, watches, advisories, statements — all event types)
   whose polygon intersects the current view, listed with full headline/description/
   instruction text and linked to the map: click a card -> fly + highlight its area;
   click an area on the map -> open its card. National list cached 60 s, re-filtered per pan. */
var ALERTS_URL = "https://api.weather.gov/alerts/active?status=actual&message_type=alert";
var alertsData = [];          // in-view alerts (sorted)
var cellTops = [];            // [{lat,lon,top}] storm-cell echo tops (kft) sampled from EET
var alertRefs = {};           // index -> { poly, center }
var alertsCache = null;       // { t, features } national list, 60 s TTL
var selectedAlertUid = null;
var SEV_COLOR = { Extreme:"#e0004d", Severe:"#e01f1f", Moderate:"#e8820c", Minor:"#c9a800", Unknown:"#7f8fa6" };
var SEV_RANK = { Extreme:0, Severe:1, Moderate:2, Minor:3, Unknown:4 };
function alertColor(sev){ return SEV_COLOR[sev] || SEV_COLOR.Unknown; }
function esc(s){ return (s == null ? "" : String(s)).replace(/[&<>"]/g, function (c){
  return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]; }); }
function fmtLocal(d){ try { return d.toLocaleString([], { month:"short", day:"numeric", hour:"numeric", minute:"2-digit", timeZoneName:"short" }); } catch(e){ return ""; } }

function fetchAllAlertsNational() {
  // active alerts change slowly; cache the ~2 MB national list 3 min so panning re-filters
  // from memory instead of refetching (re-filtering the parsed features per pan is cheap).
  if (alertsCache && !alertsCache.key && Date.now() - alertsCache.t < 180000) return Promise.resolve(alertsCache.features);
  return fetch(ALERTS_URL, { headers:{ "Accept":"application/geo+json" } })
    .then(function (r) { return r.ok ? r.json() : { features: [] }; })
    .then(function (j) { var f = j.features || []; alertsCache = { t: Date.now(), features: f }; return f; })
    .catch(function () { return (alertsCache && alertsCache.features) || []; });
}
function fetchAllAlertsCached() {
  if (!SRV.up) return fetchAllAlertsNational();
  // enhanced: the server holds the national feed and returns a bbox-filtered, slimmed
  // FeatureCollection (same NWS shape, ~95% smaller). Key the client cache by a rounded,
  // padded box so a small pan re-filters locally and a big one refetches.
  var b = map.getBounds().pad(0.6);
  var key = Math.floor(b.getSouth()) + "," + Math.floor(b.getWest()) + "," +
            Math.ceil(b.getNorth()) + "," + Math.ceil(b.getEast());
  if (alertsCache && alertsCache.key === key && Date.now() - alertsCache.t < 60000)
    return Promise.resolve(alertsCache.features);
  return fetch(SRV.url + "/api/alerts?bbox=" + key)
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (j) { var f = j.features || []; alertsCache = { t: Date.now(), features: f, key: key }; return f; })
    .catch(function () { srvFail(); alertsCache = null; return fetchAllAlertsNational(); });
}

function loadAlerts() {
  return fetchAllAlertsCached().then(function (features) {
    var b = map.getBounds().pad(0.15);
    var inView = features.filter(function (f) {
      if (!f.geometry) return false;                       // zone-only alerts have no polygon to map
      var bb = geomBBox(f.geometry);
      return bb && b.intersects(bb);
    });
    renderAlerts(inView);
  });
}

function renderAlerts(features) {
  alertsData = features.map(function (f, i) {
    var p = f.properties || {};
    return {
      uid: f.id || ("a" + i), event: p.event || "Alert", severity: p.severity || "Unknown",
      urgency: p.urgency || "", headline: p.headline || "", desc: p.description || "",
      instr: p.instruction || "", area: p.areaDesc || "", sender: p.senderName || "",
      expires: p.expires ? new Date(p.expires) : null, effective: p.effective ? new Date(p.effective) : null,
      center: centroid(f.geometry), geom: f.geometry
    };
  });
  alertsData.sort(function (x, y) {
    var d = (SEV_RANK[x.severity] != null ? SEV_RANK[x.severity] : 5) -
            (SEV_RANK[y.severity] != null ? SEV_RANK[y.severity] : 5);
    if (d) return d;
    return (x.expires ? x.expires.getTime() : Infinity) - (y.expires ? y.expires.getTime() : Infinity);
  });
  drawAlertPolys();
  buildAlertsTable();
  var atab = P("tab-alerts");
  if (atab) atab.textContent = "Alerts (" + alertsData.length + ")" + (SRV.up ? " ◆" : "");
  reapplyAlertSelection();
}

function drawAlertPolys() {
  alertLayer.clearLayers(); alertRefs = {};
  if (!document.getElementById("c-alerts").checked) return;
  alertsData.forEach(function (a, i) {
    if (!a.geom) return;
    var col = alertColor(a.severity);
    var poly = L.geoJSON(a.geom, { pane:"alerts",
      style:{ color:col, weight:1.5, fill:true, fillColor:col, fillOpacity:0.10, dashArray:"4 4" } }).addTo(alertLayer);
    poly.on("click", onAlertAreaClick);          // overlap-aware: may open a picker list
    alertRefs[i] = { poly: poly, center: a.center };
  });
}

function buildAlertsTable() {
  var body = P("alertsbody");
  if (!alertsData.length) {
    body.innerHTML = '<div class="empty">No active NWS alerts with mapped areas in view. ' +
      'Pan to an area of active weather, or zoom out to widen the search.</div>';
    return;
  }
  body.innerHTML = alertsData.map(function (a, i) {
    var areaParts = a.area.split(";");
    var area = esc(areaParts.slice(0, 3).join("; ")) + (areaParts.length > 3 ? " …" : "");
    return '<div class="alertcard sev-' + a.severity.toLowerCase() + '" data-aid="' + i + '">' +
      '<div class="ah"><span class="asev" style="background:' + alertColor(a.severity) + '">' + esc(a.severity) + '</span>' +
        '<span class="aevent">' + esc(a.event) + '</span>' +
        '<span class="atop"></span>' +
        '<span class="aexp">' + (a.expires ? "exp " + esc(fmtLocal(a.expires)) : "") + '</span></div>' +
      '<div class="aarea">' + area + '</div>' +
      '<div class="adetail">' +
        (a.headline ? '<div class="ahl">' + esc(a.headline) + '</div>' : '') +
        '<pre class="adesc">' + esc(a.desc || "(no description provided)") + '</pre>' +
        (a.instr ? '<div class="ainst"><b>PRECAUTIONARY/PREPAREDNESS ACTIONS:</b> ' + esc(a.instr) + '</div>' : '') +
        '<div class="ameta atopmeta">' + esc(a.sender) +
          (a.effective ? " · from " + esc(fmtLocal(a.effective)) : "") +
          (a.expires ? " · until " + esc(fmtLocal(a.expires)) : "") + '</div>' +
      '</div></div>';
  }).join("");
  body.querySelectorAll(".alertcard").forEach(function (c) {
    var i = parseInt(c.getAttribute("data-aid"), 10);
    c.querySelector(".ah").addEventListener("click", function () {
      if (c.classList.contains("open")) collapseAlert();      // click an open card -> collapse it
      else selectAlert(i, false);
    });
    c.addEventListener("mouseenter", function () { hoverAlert(i, true); });   // hover -> highlight its area
    c.addEventListener("mouseleave", function () { hoverAlert(i, false); });
  });
  annotateAlertTops();
}

/* max echo top (kft) of any storm cell whose centroid falls inside an alert's area */
function alertMaxTop(a) {
  if (!a.geom || !cellTops.length) return null;
  var mx = null;
  for (var i = 0; i < cellTops.length; i++) {
    var ct = cellTops[i];
    if (geomContains(a.geom, ct.lat, ct.lon) && (mx == null || ct.top > mx)) mx = ct.top;
  }
  return mx;
}
/* fill each alert card's echo-top chip from the latest sampled cell tops */
function annotateAlertTops() {
  panelDoc.querySelectorAll(".alertcard").forEach(function (c) {
    var a = alertsData[parseInt(c.getAttribute("data-aid"), 10)]; if (!a) return;
    var top = alertMaxTop(a);
    var chip = c.querySelector(".atop"), meta = c.querySelector(".atopmeta");
    if (chip) chip.textContent = top != null ? "▲" + top + "kft" : "";
    if (meta && top != null && meta.getAttribute("data-topped") !== "1") {
      meta.insertAdjacentHTML("afterbegin", '<span class="atopline">Max echo top in area: ' + top + ' kft</span>');
      meta.setAttribute("data-topped", "1");
    }
  });
}

function highlightAlert(a) {
  alertSelLayer.clearLayers();
  if (!a || !a.geom) return;
  var col = alertColor(a.severity);
  L.geoJSON(a.geom, { pane:"warn", style:{ color:col, weight:4, fill:true, fillColor:col, fillOpacity:0.28 } }).addTo(alertSelLayer);
}

function selectAlert(i, fromMap) {
  var a = alertsData[i]; if (!a) return;
  selectedAlertUid = a.uid;
  highlightAlert(a);
  panelDoc.querySelectorAll(".alertcard").forEach(function (c) {
    c.classList.toggle("open", c.getAttribute("data-aid") === String(i));
  });
  if (a.center) map.flyTo(a.center, Math.max(map.getZoom(), 7), { duration:0.6 });
  if (fromMap) showTab("alerts");
  var card = Pq('.alertcard[data-aid="' + i + '"]');
  if (card) card.scrollIntoView({ block:"nearest" });
  if (isMobile() && fromMap && !panelWin) document.getElementById("mapwrap").scrollIntoView({ behavior:"smooth", block:"start" });
}
/* collapse the open alert card + drop its persistent map highlight */
function collapseAlert() {
  selectedAlertUid = null;
  alertSelLayer.clearLayers();
  panelDoc.querySelectorAll(".alertcard.open").forEach(function (c) { c.classList.remove("open"); });
}

/* ---- point-in-polygon hit test so overlapping alert areas can be disambiguated ---- */
function pointInRing(x, y, ring) {
  var inside = false;
  for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function ringsContain(rings, x, y) {
  if (!rings.length || !pointInRing(x, y, rings[0])) return false;   // must be inside outer ring
  for (var h = 1; h < rings.length; h++) if (pointInRing(x, y, rings[h])) return false;  // and outside holes
  return true;
}
function geomContains(geom, lat, lon) {
  if (!geom) return false;
  if (geom.type === "Polygon") return ringsContain(geom.coordinates, lon, lat);
  if (geom.type === "MultiPolygon") return geom.coordinates.some(function (poly) { return ringsContain(poly, lon, lat); });
  return false;
}
/* indices of every in-view alert whose area covers the clicked point (severity-sorted already) */
function alertsAtPoint(lat, lon) {
  var hits = [];
  alertsData.forEach(function (a, i) { if (geomContains(a.geom, lat, lon)) hits.push(i); });
  return hits;
}

/* click on an alert / warning area -> select it, or (if areas overlap) offer a picker list */
function onAlertAreaClick(e) {
  var hits = alertsAtPoint(e.latlng.lat, e.latlng.lng);
  if (!hits.length) return;
  if (hits.length === 1) { selectAlert(hits[0], true); return; }
  openAlertPicker(e.latlng, hits);
}

function openAlertPicker(latlng, hits) {
  var html = '<div class="apick"><div class="apickhd">' + hits.length + ' overlapping alerts here</div>';
  hits.forEach(function (i) {
    var a = alertsData[i];
    html += '<div class="apickitem" data-ai="' + i + '">' +
      '<span class="asev" style="background:' + alertColor(a.severity) + '">' + esc(a.severity) + '</span>' +
      '<span class="apn">' + esc(a.event) + '</span></div>';
  });
  html += '</div>';
  L.popup({ className:"alertpicker", offset:[0,-2], maxWidth:300, autoPan:true })
    .setLatLng(latlng).setContent(html).openOn(map);
  setTimeout(function () {
    var box = document.querySelector(".alertpicker .apick"); if (!box) return;
    box.querySelectorAll(".apickitem").forEach(function (it) {
      var i = parseInt(it.getAttribute("data-ai"), 10);
      it.addEventListener("mouseover", function () { it.classList.add("hi"); hoverAlert(i, true); });
      it.addEventListener("mouseout",  function () { it.classList.remove("hi"); hoverAlert(i, false); });
      it.addEventListener("click", function () { hoverAlert(i, false); map.closePopup(); selectAlert(i, true); });
    });
  }, 0);
}

/* transient bold outline of one alert while its picker row is hovered */
function hoverAlert(i, on) {
  alertHoverLayer.clearLayers();
  if (!on) return;
  var a = alertsData[i]; if (!a || !a.geom) return;
  var col = alertColor(a.severity);
  L.geoJSON(a.geom, { pane:"warn", interactive:false,
    style:{ color:"#fff", weight:5, fill:true, fillColor:col, fillOpacity:0.35 } }).addTo(alertHoverLayer);
  L.geoJSON(a.geom, { pane:"warn", interactive:false,
    style:{ color:col, weight:2.5, fill:false } }).addTo(alertHoverLayer);
}

/* keep the highlight + open card after a data refresh, matching by stable alert id */
function reapplyAlertSelection() {
  if (selectedAlertUid == null) return;
  var i = -1;
  for (var k = 0; k < alertsData.length; k++) if (alertsData[k].uid === selectedAlertUid) { i = k; break; }
  if (i < 0) { alertSelLayer.clearLayers(); return; }
  highlightAlert(alertsData[i]);
  var card = Pq('.alertcard[data-aid="' + i + '"]');
  if (card) card.classList.add("open");
}

/* ===================== EXTRA WEATHER LAYERS (all toggle-able) ===================== */
var geoCache = {};
function fetchGeo(url, ttl) {
  var c = geoCache[url];
  if (c && Date.now() - c.t < (ttl || 120000)) return Promise.resolve(c.data);
  return fetch(url, { headers:{ "Accept":"application/geo+json" } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { if (j) geoCache[url] = { t: Date.now(), data: j }; return j; })
    .catch(function () { return c ? c.data : null; });
}

/* SPC Day-1 Categorical Convective Outlook (ships its own risk colors) */
var OUTLOOK_URL = "https://www.spc.noaa.gov/products/outlook/day1otlk_cat.nolyr.geojson";
function loadOutlook() {
  outlookLayer.clearLayers();
  if (!document.getElementById("c-outlook").checked) return;
  fetchGeo(OUTLOOK_URL, 600000).then(function (j) {
    if (!j || !document.getElementById("c-outlook").checked) return;
    (j.features || []).forEach(function (f) {
      var p = f.properties || {};
      L.geoJSON(f.geometry, { pane:"outlook", style:{ color:p.stroke || "#888", weight:1.5,
        fill:true, fillColor:p.fill || "#ccc", fillOpacity:0.25 } })
        .bindPopup("<b>SPC Day 1 Outlook</b><br>" + esc(p.LABEL2 || p.LABEL || "")).addTo(outlookLayer);
    });
  });
}

/* SPC Watches — tornado / severe thunderstorm watch boxes (via IEM) */
var WATCH_URL = "https://mesonet.agron.iastate.edu/json/spcwatch.py?fmt=geojson";
function loadWatches() {
  watchesLayer.clearLayers();
  if (!document.getElementById("c-watches").checked) return;
  fetchGeo(WATCH_URL, 300000).then(function (j) {
    if (!j || !document.getElementById("c-watches").checked) return;
    (j.features || []).forEach(function (f) {
      var p = f.properties || {}, tor = p.type === "TOR", col = tor ? "#e01f1f" : "#e8a200";
      L.geoJSON(f.geometry, { pane:"watches", style:{ color:col, weight:2.5, fill:true,
        fillColor:col, fillOpacity:0.06, dashArray:"9 5" } })
        .bindPopup("<b>" + (tor ? "Tornado" : "Svr T'storm") + " Watch #" + esc(p.number) + "</b>" +
          (p.is_pds ? ' <span style="color:#e01f1f">PDS</span>' : "") +
          "<br>hail&nbsp;to&nbsp;" + esc(p.max_hail_size) + '"&nbsp;· wind&nbsp;' + esc(p.max_wind_gust_knots) + "&nbsp;kt" +
          "<br>until " + esc((p.expire || "").replace("T", " ").replace("Z", " UTC")))
        .addTo(watchesLayer);
    });
  });
}

/* METAR / ASOS surface observations — in-view, de-cluttered station plots.
   Source = IEM per-state ASOS currents (CORS-open; aviationweather.gov is not). We pick the
   states whose bbox overlaps the view (capped) and merge their current obs. */
var STATE_BBOX = {  // [south, west, north, east]
  AL:[30.1,-88.5,35.1,-84.9],AZ:[31.3,-114.9,37.1,-109],AR:[33,-94.7,36.6,-89.6],CA:[32.5,-124.5,42.1,-114.1],
  CO:[36.9,-109.1,41.1,-102],CT:[40.9,-73.8,42.1,-71.7],DE:[38.4,-75.8,39.9,-75],FL:[24.4,-87.7,31.1,-80],
  GA:[30.3,-85.7,35.1,-80.8],IA:[40.3,-96.7,43.6,-90.1],ID:[41.9,-117.3,49.1,-111],IL:[36.9,-91.6,42.6,-87],
  IN:[37.7,-88.2,41.8,-84.7],KS:[36.9,-102.1,40.1,-94.6],KY:[36.5,-89.6,39.2,-81.9],LA:[28.9,-94.1,33.1,-88.8],
  MA:[41.2,-73.6,42.9,-69.9],MD:[37.9,-79.5,39.8,-75],ME:[43,-71.1,47.5,-66.9],MI:[41.7,-90.5,48.3,-82.3],
  MN:[43.4,-97.3,49.4,-89.5],MO:[35.9,-95.8,40.7,-89.1],MS:[30.1,-91.7,35.1,-88.1],MT:[44.3,-116.1,49.1,-104],
  NC:[33.8,-84.4,36.6,-75.4],ND:[45.9,-104.1,49.1,-96.5],NE:[39.9,-104.1,43.1,-95.3],NH:[42.6,-72.6,45.4,-70.6],
  NJ:[38.9,-75.6,41.4,-73.9],NM:[31.3,-109.1,37.1,-103],NV:[35,-120.1,42.1,-114],NY:[40.4,-79.8,45.1,-71.8],
  OH:[38.3,-84.9,42,-80.5],OK:[33.6,-103.1,37.1,-94.4],OR:[41.9,-124.6,46.3,-116.4],PA:[39.7,-80.6,42.3,-74.7],
  RI:[41.1,-71.9,42.1,-71.1],SC:[32,-83.4,35.3,-78.5],SD:[42.4,-104.1,45.9,-96.4],TN:[34.9,-90.4,36.7,-81.6],
  TX:[25.8,-106.7,36.6,-93.5],UT:[36.9,-114.1,42.1,-109],VA:[36.5,-83.7,39.5,-75.2],VT:[42.7,-73.5,45.1,-71.5],
  WA:[45.5,-124.9,49.1,-116.9],WI:[42.4,-92.9,47.1,-86.8],WV:[37.1,-82.7,40.7,-77.7],WY:[40.9,-111.1,45.1,-104]
};
function statesInView(b) {
  var out = [];
  for (var st in STATE_BBOX) {
    var q = STATE_BBOX[st];
    if (!(q[2] < b.getSouth() || q[0] > b.getNorth() || q[3] < b.getWest() || q[1] > b.getEast())) out.push(st);
  }
  return out.slice(0, 6);   // cap the number of network fetches
}
/* IEM per-state ASOS currents -> plain obs objects (the keyless path). */
function metarFromIem(b) {
  var states = statesInView(b);
  return Promise.all(states.map(function (st) {
    return fetchGeo("https://mesonet.agron.iastate.edu/api/1/currents.geojson?network=" + st + "_ASOS", 300000);
  })).then(function (results) {
    var feats = [];
    results.forEach(function (j) { if (j && j.features) feats = feats.concat(j.features); });
    return feats.map(function (f) { return f.properties; });
  });
}
/* aviationweather.gov via the enhancement server (CORS-blocked directly) -> same obs shape.
   AWC reports °C and true aviation METARs; adapt to the IEM-ish fields the renderer uses. */
function metarFromAwc(b) {
  var bbox = b.getSouth().toFixed(1) + "," + b.getWest().toFixed(1) + "," +
             b.getNorth().toFixed(1) + "," + b.getEast().toFixed(1);
  return fetch(SRV.url + "/api/awc/metar?bbox=" + bbox)
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (list) {
      return (list || []).map(function (o) {
        return {
          station: o.icaoId, name: o.name || "", lat: o.lat, lon: o.lon,
          tmpf: o.temp != null ? Math.round(o.temp * 9 / 5 + 32) : null,
          dwpf: o.dewp != null ? Math.round(o.dewp * 9 / 5 + 32) : null,
          drct: typeof o.wdir === "number" ? o.wdir : null,
          sknt: typeof o.wspd === "number" ? o.wspd : null,
          gust: typeof o.wgst === "number" ? o.wgst : null,
          wxcodes: o.wxString || "", raw: o.rawOb || ""
        };
      });
    });
}
/* dense mesonet obs via the server's Synoptic proxy (already client-shaped) */
function metarFromSynoptic(b) {
  var bbox = b.getSouth().toFixed(1) + "," + b.getWest().toFixed(1) + "," +
             b.getNorth().toFixed(1) + "," + b.getEast().toFixed(1);
  return fetch(SRV.url + "/api/obs?bbox=" + bbox)
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
}
function loadMetar() {
  metarLayer.clearLayers();
  if (!document.getElementById("c-metar").checked) return;
  var b = map.getBounds();
  // best available chain: Synoptic mesonet (server+token) -> AWC aviation (server) -> IEM (keyless)
  var obsP = SRV.up && SRV.synoptic
    ? metarFromSynoptic(b).catch(function () { return metarFromAwc(b); }).catch(function () { srvFail(); return metarFromIem(b); })
    : SRV.up
    ? metarFromAwc(b).catch(function () { srvFail(); return metarFromIem(b); })
    : metarFromIem(b);
  obsP.then(function (obs) {
    if (!document.getElementById("c-metar").checked) return;
    obs = obs.filter(function (p) {
      if (!p || p.tmpf == null || p.lat == null) return false;
      return p.lat >= b.getSouth() && p.lat <= b.getNorth() && p.lon >= b.getWest() && p.lon <= b.getEast();
    });
    var placed = [];
    obs.forEach(function (p) {
      var pt = map.latLngToContainerPoint([p.lat, p.lon]);
      var box = { x1: pt.x - 20, y1: pt.y - 14, x2: pt.x + 20, y2: pt.y + 14 };
      for (var i = 0; i < placed.length; i++) {
        var q = placed[i];
        if (!(box.x2 < q.x1 || box.x1 > q.x2 || box.y2 < q.y1 || box.y1 > q.y2)) return;
      }
      placed.push(box);
      metarLayer.addLayer(makeMetarMarker(p, [p.lat, p.lon]));
    });
  }).catch(function () {});
}
/* ---- click-anywhere point forecast (Open-Meteo: keyless, CORS-open, HRRR/GFS blend) ---- */
function pointForecast(latlng) {
  var url = "https://api.open-meteo.com/v1/forecast?latitude=" + latlng.lat.toFixed(3) +
    "&longitude=" + latlng.lng.toFixed(3) +
    "&hourly=temperature_2m,precipitation_probability,precipitation,wind_speed_10m,wind_gusts_10m," +
    "wind_direction_10m,cape&forecast_hours=12&temperature_unit=fahrenheit&wind_speed_unit=kn&timezone=UTC";
  var pop = L.popup({ maxWidth: 280 })
    .setLatLng(latlng)
    .setContent('<div class="ptfcst"><b>Point forecast</b><br><span class="pf-load">fetching Open-Meteo…</span></div>')
    .openOn(map);
  fetch(url).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
    var h = j && j.hourly;
    if (!h || !h.time || !h.time.length) { pop.setContent('<div class="ptfcst">Forecast unavailable.</div>'); return; }
    var rows = "";
    for (var i = 0; i < h.time.length && i < 12; i += 2) {          // every 2 h over the next 12
      var wd = h.wind_direction_10m[i], ws = Math.round(h.wind_speed_10m[i] || 0);
      var g = Math.round(h.wind_gusts_10m[i] || 0);
      rows += "<tr><td>" + esc(h.time[i].slice(11, 16)) + "Z</td>" +
        "<td>" + Math.round(h.temperature_2m[i]) + "&deg;</td>" +
        "<td>" + (h.precipitation_probability[i] != null ? h.precipitation_probability[i] + "%" : "—") + "</td>" +
        "<td>" + (ws > 0 ? compass(wd) + " " + ws + (g > ws + 8 ? "G" + g : "") : "calm") + "</td></tr>";
    }
    var cape = h.cape && h.cape[0] != null ? Math.round(h.cape[0]) : null;
    pop.setContent('<div class="ptfcst"><b>Point forecast</b> <span class="pf-ll">' +
      latlng.lat.toFixed(2) + ", " + latlng.lng.toFixed(2) + "</span>" +
      '<table class="pf"><tr><th>UTC</th><th>&deg;F</th><th>precip</th><th>wind kt</th></tr>' + rows + "</table>" +
      (cape != null ? '<div class="pf-cape">CAPE now: ' + cape + " J/kg</div>" : "") +
      '<div class="pf-src">Open-Meteo (HRRR/GFS blend)</div></div>');
  }).catch(function () { pop.setContent('<div class="ptfcst">Forecast unavailable.</div>'); });
}
map.on("click", function (e) {
  var cb = document.getElementById("c-ptfcst");
  if (!cb || !cb.checked) return;
  // ignore clicks that land on interactive features (polygons, markers, popups)
  var t = e.originalEvent && e.originalEvent.target;
  if (t && t.closest && (t.closest(".leaflet-interactive") || t.closest(".leaflet-marker-icon") ||
      t.closest(".leaflet-popup") || t.closest(".metarwrap") || t.closest(".cellmark-wrap"))) return;
  pointForecast(e.latlng);
});

/* ---- plain-English METAR decode (shown in the station popup under the raw report) ---- */
var METAR_WX = {
  TS:"thunderstorm", SH:"showers of", FZ:"freezing", BL:"blowing", DR:"drifting",
  MI:"shallow", BC:"patches of", PR:"partial", RA:"rain", SN:"snow", DZ:"drizzle",
  GR:"hail", GS:"small hail", PL:"ice pellets", IC:"ice crystals", UP:"unknown precipitation",
  BR:"mist", FG:"fog", HZ:"haze", FU:"smoke", DU:"dust", SA:"sand", VA:"volcanic ash",
  PY:"spray", SQ:"squalls", FC:"FUNNEL CLOUD", PO:"dust whirls", DS:"dust storm", SS:"sandstorm"
};
var METAR_SKY = { FEW:"few clouds", SCT:"scattered clouds", BKN:"broken clouds", OVC:"overcast" };
function cToF(c) { return Math.round(c * 9 / 5 + 32); }
function decodeMetar(raw) {
  if (!raw) return [];
  var toks = raw.split(/\s+RMK\s/)[0].replace(/=+\s*$/, "").split(/\s+/);
  var wind = null, vis = null, wx = [], sky = [], td = null, alt = null, time = null, vary = null;
  var m, i;
  for (i = 0; i < toks.length; i++) {
    var t = toks[i];
    if ((m = /^(\d{2})(\d{2})(\d{2})Z$/.exec(t))) { time = "observed " + m[2] + ":" + m[3] + "Z"; }
    else if ((m = /^(VRB|\d{3})(\d{2,3})(?:G(\d{2,3}))?KT$/.exec(t))) {
      var spd = parseInt(m[2], 10);
      if (m[1] !== "VRB" && spd === 0) wind = "wind calm";
      else wind = "wind " + (m[1] === "VRB" ? "variable" : "from the " + compass(parseInt(m[1], 10))) +
        " at " + spd + " kt" + (m[3] ? ", gusting " + parseInt(m[3], 10) + " kt" : "");
    }
    else if ((m = /^(\d{3})V(\d{3})$/.exec(t))) { vary = "direction varying " + m[1] + "°–" + m[2] + "°"; }
    else if ((m = /^P?(\d{1,2})SM$/.exec(t))) { vis = "visibility " + (t.charAt(0) === "P" ? "over " : "") + parseInt(m[1], 10) + " mi"; }
    else if ((m = /^(\d)\/(\d{1,2})SM$/.exec(t))) {
      var whole = /^\d{1,2}$/.test(toks[i - 1] || "") ? toks[i - 1] + " " : "";   // "1 1/2SM"
      vis = "visibility " + whole + m[1] + "/" + m[2] + " mi";
    }
    else if ((m = /^(SKC|CLR|NSC|NCD)$/.exec(t))) { sky.push("sky clear"); }
    else if ((m = /^(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?$/.exec(t))) {
      sky.push(METAR_SKY[m[1]] + " at " + (parseInt(m[2], 10) * 100).toLocaleString() + " ft" +
        (m[3] === "CB" ? " (thunderheads)" : m[3] === "TCU" ? " (towering cumulus)" : ""));
    }
    else if ((m = /^VV(\d{3})$/.exec(t))) { sky.push("sky obscured, vertical visibility " + (parseInt(m[1], 10) * 100) + " ft"); }
    else if ((m = /^(M?\d{1,2})\/(M?\d{1,2})$/.exec(t))) {
      var tc = parseInt(m[1].replace("M", "-"), 10), dc = parseInt(m[2].replace("M", "-"), 10);
      td = "temp " + cToF(tc) + "°F, dewpoint " + cToF(dc) + "°F";
    }
    else if ((m = /^A(\d{4})$/.exec(t))) { alt = "altimeter " + m[1].slice(0, 2) + "." + m[1].slice(2) + " inHg"; }
    else if ((m = /^Q(\d{4})$/.exec(t))) { alt = "altimeter " + parseInt(m[1], 10) + " hPa"; }
    else if ((m = /^([+-]|VC)?([A-Z]{2,6})$/.exec(t)) && t !== "AUTO" && t !== "METAR" && t !== "SPECI" && t !== "COR") {
      // present weather: optional intensity + a chain of known 2-letter codes
      var body = m[2], words = [], ok = body.length >= 2 && body.length % 2 === 0;
      for (var q = 0; ok && q < body.length; q += 2) {
        var w = METAR_WX[body.slice(q, q + 2)];
        if (w) words.push(w); else ok = false;
      }
      if (ok) wx.push((m[1] === "+" ? "heavy " : m[1] === "-" ? "light " : m[1] === "VC" ? "nearby " : "") + words.join(" "));
    }
  }
  var out = [];
  if (time) out.push(time);
  if (wind) out.push(wind + (vary ? " (" + vary + ")" : ""));
  if (vis) out.push(vis);
  if (wx.length) out.push(wx.join("; "));
  if (sky.length) out.push(sky.join(", "));
  if (td) out.push(td);
  if (alt) out.push(alt);
  return out;
}

function makeMetarMarker(p, latlng) {
  var arrow = (p.drct != null && p.sknt != null && p.sknt > 0)
    ? '<span class="mw" style="transform:rotate(' + ((p.drct + 180) % 360) + 'deg)">&#8593;</span>' : "";
  var html = '<div class="metar"><span class="mt">' + Math.round(p.tmpf) + '&deg;</span>' + arrow + '</div>';
  return L.marker(latlng, { pane:"metar", icon: L.divIcon({ className:"metarwrap", iconSize:[0,0], html:html }) })
    .bindPopup("<b>" + esc(p.station) + "</b> " + esc(p.name || "") +
      "<br>T " + Math.round(p.tmpf) + "&deg;F&nbsp;·&nbsp;Td " + (p.dwpf != null ? Math.round(p.dwpf) : "—") + "&deg;F" +
      "<br>wind " + esc(p.drct) + "&deg; @ " + esc(p.sknt) + " kt" + (p.gust ? " G" + esc(p.gust) : "") +
      (p.wxcodes ? "<br>wx: " + esc(p.wxcodes) : "") + '<br><small>' + esc(p.raw || "") + "</small>" +
      (function () {                       // plain-English decode of the raw report
        var lines = decodeMetar(p.raw);
        return lines.length ? '<div class="mdecode">' + lines.map(esc).join("<br>") + "</div>" : "";
      })());
}

/* ===================== STORM PANEL TABS ===================== */
function showTab(which) {
  var isText = which === "text", isAlerts = which === "alerts", isTable = !isText && !isAlerts;
  P("tablebody").style.display = isTable ? "" : "none";
  P("textreadout").style.display = isText ? "" : "none";
  P("alertsbody").style.display = isAlerts ? "" : "none";
  P("tab-table").classList.toggle("active", isTable);
  P("tab-text").classList.toggle("active", isText);
  P("tab-alerts").classList.toggle("active", isAlerts);
}
document.getElementById("tab-table").addEventListener("click", function () { showTab("table"); });
document.getElementById("tab-text").addEventListener("click", function () { showTab("text"); });
document.getElementById("tab-alerts").addEventListener("click", function () { showTab("alerts"); });
document.getElementById("c-alerts").addEventListener("change", function () { drawAlertPolys(); reapplyAlertSelection(); });

/* ---- drag-resize the storm panel ---- */
(function setupPanelResize() {
  var rz = document.getElementById("tableresize");
  var tw = document.getElementById("tablewrap");
  var stage = document.getElementById("stage");
  if (!rz || !tw || !stage) return;
  rz.addEventListener("pointerdown", function (e) {
    if (panelWin) return;                      // no-op while popped out
    e.preventDefault();
    var startY = e.clientY, startH = tw.offsetHeight;
    try { rz.setPointerCapture(e.pointerId); } catch (_) {}
    function move(ev) {
      var maxH = Math.max(120, stage.clientHeight - 210);        // keep room for the map
      var h = Math.max(90, Math.min(maxH, startH - (ev.clientY - startY)));  // drag up -> taller
      tw.style.height = h + "px";
      if (map) map.invalidateSize(false);
    }
    function up() {
      try { rz.releasePointerCapture(e.pointerId); } catch (_) {}
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
    }
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  });
})();

/* ---- pop the storm panel out into its own window (and dock it back) ---- */
function popOutPanel() {
  if (panelWin && !panelWin.closed) { panelWin.focus(); return; }
  var w = window.open("", "crStormPanel", "width=940,height=460");
  if (!w) { setTableStatus("Pop-out blocked — allow popups for this site."); return; }
  var base = location.origin + location.pathname.replace(/[^/]*$/, "");
  w.document.open();
  w.document.write('<!doctype html><html><head><meta charset="utf-8">' +
    '<title>Classic Radar — Storm Panel</title>' +
    '<link rel="stylesheet" href="' + base + 'styles.css"></head><body class="popout"></body></html>');
  w.document.close();
  panelWin = w;
  var tw = document.getElementById("tablewrap");
  panelHome = document.createComment("cr-panel-home");
  tw.parentNode.insertBefore(panelHome, tw);
  w.document.body.appendChild(w.document.adoptNode(tw));   // move the live panel into the popup
  panelDoc = w.document;
  document.getElementById("stage").classList.add("panel-popped");
  var pb = P("tab-pop"); if (pb) pb.textContent = "⧉ Dock back in";
  if (map) map.invalidateSize();
  w.addEventListener("beforeunload", dockPanel);          // closing the window re-docks
}
function dockPanel() {
  if (!panelWin) return;
  var w = panelWin; panelWin = null;
  var tw = (panelDoc && panelDoc.getElementById) ? panelDoc.getElementById("tablewrap") : null;
  panelDoc = document;
  if (tw && panelHome && panelHome.parentNode) {
    panelHome.parentNode.insertBefore(document.adoptNode(tw), panelHome);
    panelHome.parentNode.removeChild(panelHome);
  }
  panelHome = null;
  document.getElementById("stage").classList.remove("panel-popped");
  var pb = document.getElementById("tab-pop"); if (pb) pb.textContent = "⧉ Pop out";
  if (map) map.invalidateSize();
  try { if (w && !w.closed) w.close(); } catch (_) {}
}
document.getElementById("tab-pop").addEventListener("click", function () {
  if (panelWin && !panelWin.closed) dockPanel(); else popOutPanel();
});
window.addEventListener("beforeunload", function () {
  if (panelWin && !panelWin.closed) { try { panelWin.close(); } catch (_) {} }
});

document.getElementById("refresh").addEventListener("click", function () {
  var src = currentProductSrc();
  if (src === "rv" || src === "sat") loadRainViewer();
  else if (src === "precip" || src === "mrms") applyProduct();   // re-request the layer + loop
  eetCache = {}; dvlCache = {}; alertsCache = null; geoCache = {};  // force-refresh Level III + alerts + vectors
  loadWarnings();
  loadOutlook(); loadWatches(); loadMetar();          // no-ops when their toggles are off
});

/* ===================== AUTO-REFRESH (live mode) =====================
   A radar page that only updates when poked goes silently stale. Every AUTO_MS the site
   re-pulls the current still (cache-busted), warnings/cells/alerts and — when on — METAR;
   the per-source caches (60-180 s) keep the actual network cost small. Held while the
   animation is playing or the tab is hidden; coming back after a long absence refreshes
   immediately. The masthead shows a classic "upd :SS" countdown. */
var AUTO_SECS = 120;
var autoLeft = AUTO_SECS;
function refreshStill() {
  var src = currentProductSrc();
  var sel = document.getElementById("product");
  var opt = sel.options[sel.selectedIndex];
  if (src === "rv") {
    if (usingFrames) return;                        // animating: frames are already historical
    if (compLayer) compLayer.setParams({ _t: Date.now() });
    if (iemLayer) iemLayer.setUrl(IEM_URL + "?_=" + Date.now());
  } else if (src === "sat") {
    showSat(opt.getAttribute("data-sat"));          // GIBS "default" time -> latest scan
  } else if (src === "precip") {
    if (precipLayer) { precipLayer._crBust = Date.now(); precipLayer.redraw(); }
  } else if (src === "mrms") {
    refreshMrms(opt.getAttribute("data-mrms"));
  }
}
function autoRefresh() {
  refreshStill();
  loadWarnings();                                   // NST/EET/DVL/alert caches gate refetches
  if (document.getElementById("c-metar").checked) loadMetar();
}
setInterval(function () {
  var el = document.getElementById("autonext");
  var cb = document.getElementById("c-autorefresh");
  if (!cb || !cb.checked) { if (el) el.textContent = ""; autoLeft = AUTO_SECS; return; }
  if (playing || document.hidden) { if (el) el.textContent = ""; return; }   // hold, don't count down
  if (--autoLeft <= 0) { autoLeft = AUTO_SECS; autoRefresh(); }
  if (el) el.textContent = "upd :" + pad(autoLeft > 99 ? 99 : autoLeft);
}, 1000);
document.addEventListener("visibilitychange", function () {
  if (!document.hidden && document.getElementById("c-autorefresh").checked) autoLeft = Math.min(autoLeft, 2);
});

/* ===================== NEW-WARNING CHIME =====================
   Optional two-tone chime when a warning id we have never seen appears IN VIEW (seen-set is
   national, so panning into existing warnings stays silent). Enabling the box is the user
   gesture that lets the AudioContext start. */
var seenWarnIds = null;
function chimeCheck(features, bounds) {
  var ids = {}, freshInView = false;
  features.forEach(function (f) {
    var id = f.id || (f.properties && f.properties.id) || "";
    if (!id) return;
    ids[id] = 1;
    if (seenWarnIds && !(id in seenWarnIds)) {
      var bb = geomBBox(f.geometry);
      if (bb && bounds.intersects(bb)) freshInView = true;
    }
  });
  var cb = document.getElementById("c-chime");
  if (freshInView && cb && cb.checked) chime();
  seenWarnIds = ids;
}
function chime() {
  try {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    var ac = chime._ac || (chime._ac = new AC());
    if (ac.state === "suspended") ac.resume();
    [880, 660].forEach(function (fq, i) {
      var o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = fq; o.type = "sine";
      var t0 = ac.currentTime + i * 0.28;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.22, t0 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.26);
      o.connect(g); g.connect(ac.destination);
      o.start(t0); o.stop(t0 + 0.3);
    });
  } catch (e) {}
}

var moveTimer = null;
map.on("moveend", function () {
  clearTimeout(moveTimer);
  moveTimer = setTimeout(function () {
    loadWarnings();                                       // in-view storm cells + tops
    if (document.getElementById("c-metar").checked) loadMetar();   // in-view surface obs
  }, 500);
});
map.on("popupclose", function () { alertHoverLayer.clearLayers(); });   // drop any picker hover preview

/* ===================== PERSISTENCE (localStorage) =====================
   Remember the user's map controls + view across reloads. localStorage (not a cookie):
   not sent to any server, no size limit, and this is a static site. */
var PREFS_KEY = "classicRadar.prefs.v1";
var PREF_CHECKS = ["c-base","c-county","c-hwy","c-city","c-warn","c-alerts","c-cells","c-tracks",
                   "c-tops","c-watches","c-outlook","c-metar","c-sites","c-iem",
                   "c-autorefresh","c-chime","c-ptfcst"];
var PREF_SELECTS = ["product","frames","speed","dwell","network"];
var restoredView = false;

function loadPrefs() { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") || {}; } catch (e) { return {}; } }
function savePrefs() {
  try {
    var p = { checks:{}, selects:{}, opacity: document.getElementById("opacity").value };
    PREF_CHECKS.forEach(function (id) { var e = document.getElementById(id); if (e) p.checks[id] = e.checked; });
    PREF_SELECTS.forEach(function (id) { var e = document.getElementById(id); if (e) p.selects[id] = e.value; });
    var c = map.getCenter();
    p.view = { lat: +c.lat.toFixed(4), lon: +c.lng.toFixed(4), zoom: map.getZoom() };
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch (e) {}
}
function optSrc(sel) {                                   // data-src of a select's current option
  var o = sel.options[sel.selectedIndex]; return o ? o.getAttribute("data-src") : null;
}
function restorePrefs() {
  var p = loadPrefs();
  if (p.selects) PREF_SELECTS.forEach(function (id) {
    var v = p.selects[id], e = document.getElementById(id);
    if (e && v != null && [].some.call(e.options, function (o) { return o.value === v; })) e.value = v;
  });
  // don't auto-open the 3D volumetric view on load — fall back to base reflectivity;
  // same for server-only selections (the server probe hasn't finished at boot)
  var prod = document.getElementById("product");
  if (optSrc(prod) === "d3" || optSrc(prod) === "mrms") prod.value = "N0B";
  var fr = document.getElementById("frames");
  if (fr.value.charAt(0) === "s") fr.value = "24";
  if (p.checks) PREF_CHECKS.forEach(function (id) { var e = document.getElementById(id); if (e && id in p.checks) e.checked = p.checks[id]; });
  if (p.opacity != null) { var o = document.getElementById("opacity"); if (o) o.value = p.opacity; }
  if (p.view && isFinite(p.view.lat) && isFinite(p.view.lon)) {
    map.setView([p.view.lat, p.view.lon], p.view.zoom || map.getZoom());
    restoredView = true;
  }
}
function applyRestoredLayers() {
  // fire each toggle so restored layer/opacity states actually take effect (saving not yet wired)
  PREF_CHECKS.forEach(function (id) { var e = document.getElementById(id); if (e) e.dispatchEvent(new Event("change", { bubbles:true })); });
  document.getElementById("opacity").dispatchEvent(new Event("input", { bubbles:true }));
}
function wirePrefSaving() {
  PREF_CHECKS.concat(PREF_SELECTS).forEach(function (id) { var e = document.getElementById(id); if (e) e.addEventListener("change", savePrefs); });
  document.getElementById("opacity").addEventListener("change", savePrefs);
  map.on("moveend", savePrefs);
}

/* ---- enhancement-server settings UI ---- */
(function wireServerUi() {
  var inp = document.getElementById("server-url");
  var btn = document.getElementById("server-apply");
  if (!inp || !btn) return;
  inp.value = srvSavedUrl();
  btn.addEventListener("click", function () {
    var u = inp.value.replace(/\s+/g, "").replace(/\/+$/, "");
    srvSaveUrl(u);
    var st = document.getElementById("server-status");
    if (st) st.textContent = u ? "Probing " + u + "…" : "Server cleared — running keyless.";
    if (!u) { srvSetState("", null); return; }
    srvProbe(u, function (h) {
      srvSetState(u, h);
      if (h) { alertsCache = null; loadWarnings(); }     // switch data paths over right away
    });
  });
})();

/* ============================= BOOT ============================= */
buildLegend();
startClock();
setStatus("Loading radar sites…");
restorePrefs();     // apply saved control values + map view before anything reads them
srvInit();          // probe the optional enhancement server (saved URL, then same-origin)
loadStations().then(function () { buildSiteMarkers(); if (!restoredView) centerOnSite(); });
applyProduct();     // reads the restored product (default: base reflectivity / IEM live)
loadWarnings();
applyRestoredLayers();   // sync toggled layers + opacity to the restored state
wirePrefSaving();        // from here on, any control/view change persists

})();
