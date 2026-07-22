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
      "&bboxSR=3857&imageSR=3857&size=256,256&format=png&transparent=true&f=image&renderingRule=" + rule +
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
function loadRainViewer() {
  var n = parseInt(document.getElementById("frames").value, 10);
  var scheme = currentScheme();
  return fetch("https://api.rainviewer.com/public/weather-maps.json")
    .then(function (r) { return r.json(); })
    .then(function (j) {
      clearFrames();
      var past = (j.radar && j.radar.past) || [];
      var use = past.slice(Math.max(0, past.length - n));
      use.forEach(function (f) {
        frameUrls.push(j.host + f.path + "/256/{z}/{x}/{y}/" + scheme + "/1_1.png");
        frameTimes.push(f.time);
      });
      if (frameUrls.length) {
        // TWO layers, double-buffered: the next frame preloads on the hidden buffer, then we
        // swap by opacity -> instant, no clearing/strobe. Only ~2 frames load at once (vs 12),
        // so RainViewer isn't rate-limited into dropped tiles. Native z7 -> clamp + upscale.
        var lastUrl = frameUrls[frameUrls.length - 1];
        for (var bi = 0; bi < 2; bi++) {
          var lyr = attachRetry(L.tileLayer(lastUrl, { pane:"radar", opacity:0, maxZoom:18,
            maxNativeZoom:7, noWrap:true, attribution:"Radar &copy; RainViewer" }), "RainViewer loop").addTo(map);
          lyr._crFrame = frameUrls.length - 1;
          buffers.push(lyr);
        }
      }
      curFrame = frameUrls.length - 1;
      wireScrub();
      goLive();                    // default to the reliable IEM current scan; PLAY switches to the loop
      return true;
    });
}

var usingFrames = false;   // true while showing the RainViewer loop; false = reliable IEM "live"

/* return to the reliable IEM current scan (shown at every zoom) */
function goLive() {
  if (srvActive) closeSingleRadar(false);                // LIVE returns to the composite
  usingFrames = false;
  buffers.forEach(function (l) { l.setOpacity(0); });
  if (currentProductSrc() === "rv") showIem(true);
  document.getElementById("stamp").textContent = "IEM current";
  document.getElementById("frameidx").textContent = "live";
  var s = document.getElementById("scrub"); if (s) s.value = s.max;
}

function showFrame(i) {
  if (!frameUrls.length || buffers.length < 2) return;
  usingFrames = true;
  showIem(false);                 // hide IEM while the animation frame is up
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

/* --- product switch: reflectivity products animate the RainViewer loop;
   the crisp IEM true-dBZ still is a separate toggle (c-iem). --- */
function applyProduct() {
  var sel = document.getElementById("product");
  var opt = sel.options[sel.selectedIndex];
  var src = opt.getAttribute("data-src");
  var note = document.getElementById("prodnote");
  pause();
  if (srvActive) closeSingleRadar(false);                // changing product drops the single-radar overlay
  clearPrecip(); clearPrecipKey();                       // and any MRMS precip layer + its key
  document.getElementById("legend").style.display = (src === "rv") ? "" : "none";  // dBZ scale is refl-only

  if (src === "rv") {
    clearSat();
    setPlaybar(true);
    var stillName = (opt.value === "NCR") ? "MRMS composite reflectivity (column-max)" : "IEM base reflectivity (0.5° tilt)";
    note.textContent = opt.text.replace(/&deg;/g,"°") +
      " — current " + stillName + " still. Press PLAY for the last ~2 h RainViewer loop; " +
      "◉ LIVE returns to the current still.";
    loadRainViewer();
  } else if (src === "sat") {
    clearFrames();
    setPlaybar(false);
    showSat(opt.getAttribute("data-sat"));
    note.textContent = opt.text.replace(/&deg;/g,"°") +
      " — GOES-East, latest scan (NASA GIBS). Full-disk coverage, updates ~every 10 min.";
    document.getElementById("stamp").textContent = "GOES latest";
  } else if (src === "precip") {
    clearFrames(); clearSat();
    setPlaybar(false);
    showPrecip(opt.getAttribute("data-rule"));
    note.textContent = opt.text.replace(/&deg;/g,"°") +
      " — NOAA/NWS MRMS gauge-corrected QPE (inches). National mosaic, updates ~hourly.";
    document.getElementById("stamp").textContent = "MRMS QPE";
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
    // fetch Enhanced Echo Tops only for the radars that actually returned cells (cached)
    var eetSites = l3List.filter(function (e) { return e.result.cells && e.result.cells.length; });
    return Promise.all(eetSites.map(function (e) {
      return fetchEETCached(Level3.site3(e.site.id)).then(function (s) { return { id: e.site.id, sampler: s }; });
    })).then(function (eets) {
      var eetBySite = {};
      eets.forEach(function (e) { if (e.sampler) eetBySite[e.id] = e.sampler; });
      renderStorm(res[0], l3List, eetBySite);
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

function renderStorm(features, l3List, eetBySite) {
  eetBySite = eetBySite || {};
  warnLayer.clearLayers();
  trackLayer.clearLayers();
  topsLayer.clearLayers();
  cellMarkers.forEach(function (m){ map.removeLayer(m); });
  cellMarkers = []; rowsById = {}; cellRefs = {}; selectedId = null;
  lastL3 = l3List[0] ? l3List[0].result : null;

  var bounds = map.getBounds().pad(0.15);
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
    res.cells.forEach(function (c) {
      if (c.lat < bounds.getSouth() || c.lat > bounds.getNorth() ||
          c.lon < bounds.getWest() || c.lon > bounds.getEast()) return;
      var top = (eet && c.az != null && c.ran != null) ? eet.sampleTop(c.az, c.ran) : null;
      rows.push({
        key: c.id + "#" + si, id: c.id, site: entry.site.id,
        glyph: "●", cls: "t-cell", threat: "cell", event: "Radar cell · " + entry.site.id,
        hail: null, wind: null, dir: (c.headingToward != null ? compass(c.headingToward) : "—"),
        spd: c.speedKt >= 0 ? c.speedKt : null, top: top,
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
    '<th>ID</th><th>Threat</th><th>Event</th><th>Top (kft)</th><th>Max Hail (in)</th>' +
    '<th>Max Wind (kt)</th><th>Dir</th><th>Spd (kt)</th><th>Area</th><th>Expires</th>' +
    '</tr></thead><tbody>';
  rows.forEach(function (r) {
    rowsById[r.key] = r;
    h += '<tr data-key="' + r.key + '">' +
      '<td class="id">' + r.id + '</td>' +
      '<td class="ev"><span class="threat ' + r.cls + '">' + r.glyph + "</span> " + r.threat.toUpperCase() + '</td>' +
      '<td class="ev">' + r.event + '</td>' +
      '<td>' + (r.top != null ? r.top : "—") + '</td>' +
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
  if (document.getElementById("product").options[document.getElementById("product").selectedIndex].getAttribute("data-src") === "rv")
    loadRainViewer();
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

function fetchAllAlertsCached() {
  // active alerts change slowly; cache the ~2 MB national list 3 min so panning re-filters
  // from memory instead of refetching (re-filtering the parsed features per pan is cheap).
  if (alertsCache && Date.now() - alertsCache.t < 180000) return Promise.resolve(alertsCache.features);
  return fetch(ALERTS_URL, { headers:{ "Accept":"application/geo+json" } })
    .then(function (r) { return r.ok ? r.json() : { features: [] }; })
    .then(function (j) { var f = j.features || []; alertsCache = { t: Date.now(), features: f }; return f; })
    .catch(function () { return (alertsCache && alertsCache.features) || []; });
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
  if (atab) atab.textContent = "Alerts (" + alertsData.length + ")";
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
function loadMetar() {
  metarLayer.clearLayers();
  if (!document.getElementById("c-metar").checked) return;
  var b = map.getBounds(), states = statesInView(b);
  Promise.all(states.map(function (st) {
    return fetchGeo("https://mesonet.agron.iastate.edu/api/1/currents.geojson?network=" + st + "_ASOS", 300000);
  })).then(function (results) {
    if (!document.getElementById("c-metar").checked) return;
    var feats = [];
    results.forEach(function (j) { if (j && j.features) feats = feats.concat(j.features); });
    feats = feats.filter(function (f) {
      var p = f.properties; if (!p || p.tmpf == null || p.lat == null) return false;
      return p.lat >= b.getSouth() && p.lat <= b.getNorth() && p.lon >= b.getWest() && p.lon <= b.getEast();
    });
    var placed = [];
    feats.forEach(function (f) {
      var p = f.properties, pt = map.latLngToContainerPoint([p.lat, p.lon]);
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
function makeMetarMarker(p, latlng) {
  var arrow = (p.drct != null && p.sknt != null && p.sknt > 0)
    ? '<span class="mw" style="transform:rotate(' + ((p.drct + 180) % 360) + 'deg)">&#8593;</span>' : "";
  var html = '<div class="metar"><span class="mt">' + Math.round(p.tmpf) + '&deg;</span>' + arrow + '</div>';
  return L.marker(latlng, { pane:"metar", icon: L.divIcon({ className:"metarwrap", iconSize:[0,0], html:html }) })
    .bindPopup("<b>" + esc(p.station) + "</b> " + esc(p.name || "") +
      "<br>T " + Math.round(p.tmpf) + "&deg;F&nbsp;·&nbsp;Td " + (p.dwpf != null ? Math.round(p.dwpf) : "—") + "&deg;F" +
      "<br>wind " + esc(p.drct) + "&deg; @ " + esc(p.sknt) + " kt" + (p.gust ? " G" + esc(p.gust) : "") +
      (p.wxcodes ? "<br>wx: " + esc(p.wxcodes) : "") + '<br><small>' + esc(p.raw || "") + "</small>");
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
  var src = document.getElementById("product").options[document.getElementById("product").selectedIndex].getAttribute("data-src");
  if (src === "rv") loadRainViewer();
  else if (src === "precip") applyProduct();          // re-request the MRMS layer
  eetCache = {}; alertsCache = null; geoCache = {};    // force-refresh cached Level III + alerts + vectors
  loadWarnings();
  loadOutlook(); loadWatches(); loadMetar();          // no-ops when their toggles are off
});

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
                   "c-tops","c-watches","c-outlook","c-metar","c-sites","c-iem"];
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
  // don't auto-open the 3D volumetric view on load — fall back to base reflectivity
  var prod = document.getElementById("product");
  if (optSrc(prod) === "d3") prod.value = "N0B";
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

/* ============================= BOOT ============================= */
buildLegend();
startClock();
setStatus("Loading radar sites…");
restorePrefs();     // apply saved control values + map view before anything reads them
loadStations().then(function () { buildSiteMarkers(); if (!restoredView) centerOnSite(); });
applyProduct();     // reads the restored product (default: base reflectivity / IEM live)
loadWarnings();
applyRestoredLayers();   // sync toggled layers + opacity to the restored state
wirePrefSaving();        // from here on, any control/view change persists

})();
