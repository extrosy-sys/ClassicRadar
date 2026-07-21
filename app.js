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

function pane(name, z) { map.createPane(name); map.getPane(name).style.zIndex = z; }
pane("radar", 250);
pane("clutter", 350);
pane("warn", 400);
pane("sites", 500);
pane("track", 620);
pane("cells", 640);

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
var iemLayer = null;          // live still (IEM base reflectivity)
var frameLayers = [];         // RainViewer animated frames
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
         maxNative:7, opacity:0.95 }
};
function clearSat() { if (satLayer) { map.removeLayer(satLayer); satLayer = null; } }
function showSat(kind) {
  clearSat();
  var g = GIBS[kind]; if (!g) return;
  satLayer = attachRetry(L.tileLayer(g.url, { pane:"radar", opacity:g.opacity, maxZoom:18,
    maxNativeZoom:g.maxNative, noWrap:true, attribution:"Satellite &copy; NASA GIBS / NOAA GOES-East" }), "Satellite").addTo(map);
}

function clearFrames() {
  frameLayers.forEach(function (l) { map.removeLayer(l); });
  frameLayers = []; frameTimes = [];
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
  var manual = document.getElementById("c-iem").checked;
  if (currentProductSrc() !== "rv") { showIem(manual); return; }
  showIem(manual || !usingFrames);      // reliable IEM base whenever not actively looping
}
function showIem(on) {
  if (on && !iemLayer) {
    iemLayer = attachRetry(L.tileLayer(IEM_URL, { pane:"radar", opacity:radarOpacity(), maxZoom:18, maxNativeZoom:12,
      noWrap:true, zIndex:20, attribution:"Base reflectivity &copy; Iowa Environmental Mesonet" }), "IEM base reflectivity").addTo(map);
  } else if (!on && iemLayer) {
    map.removeLayer(iemLayer); iemLayer = null;
  }
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
        var url = j.host + f.path + "/256/{z}/{x}/{y}/" + scheme + "/1_1.png";
        // RainViewer's radar mosaic is only rendered to z7; above that its server returns a
        // "Zoom Level Not Supported" tile. Clamp to z7 so Leaflet upscales those pixels instead.
        var lyr = attachRetry(L.tileLayer(url, { pane:"radar", opacity:0, maxZoom:18, maxNativeZoom:7, noWrap:true,
          attribution:"Radar &copy; RainViewer" }), "RainViewer loop").addTo(map);
        frameLayers.push(lyr);
        frameTimes.push(f.time);
      });
      curFrame = frameLayers.length - 1;
      wireScrub();
      goLive();                    // default to the reliable IEM current scan; PLAY switches to the loop
      return true;
    });
}

var usingFrames = false;   // true while showing the RainViewer loop; false = reliable IEM "live"

/* return to the reliable IEM current scan (shown at every zoom) */
function goLive() {
  usingFrames = false;
  frameLayers.forEach(function (l) { l.setOpacity(0); });
  if (currentProductSrc() === "rv") showIem(true);
  document.getElementById("stamp").textContent = "IEM current";
  document.getElementById("frameidx").textContent = "live";
  var s = document.getElementById("scrub"); if (s) s.value = s.max;
}

function showFrame(i) {
  if (!frameLayers.length) return;
  usingFrames = true;
  showIem(false);                 // hide IEM while the animation frame is up
  curFrame = (i + frameLayers.length) % frameLayers.length;
  var op = radarOpacity();
  for (var k = 0; k < frameLayers.length; k++) {
    frameLayers[k].setOpacity(k === curFrame ? op : 0);
  }
  var t = new Date(frameTimes[curFrame] * 1000);
  document.getElementById("stamp").textContent = fmtStamp(t);
  document.getElementById("scrub").value = curFrame;
  document.getElementById("frameidx").textContent = (curFrame + 1) + "/" + frameLayers.length;
}
function wireScrub() {
  var s = document.getElementById("scrub");
  s.max = Math.max(0, frameLayers.length - 1);
  s.value = curFrame;
}

function tick() {
  if (curFrame === frameLayers.length - 1 && dwellLeft > 0) { dwellLeft--; return; }
  var next = curFrame + 1;
  if (next >= frameLayers.length) { next = 0; dwellLeft = parseInt(document.getElementById("dwell").value, 10) - 1; }
  showFrame(next);
}
function play() {
  if (!frameLayers.length) return;
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

  if (src === "rv") {
    clearSat();
    setPlaybar(true);
    note.textContent = opt.text.replace(/&deg;/g,"°") +
      " — shows the crisp IEM current scan (reliable at every zoom). Press PLAY for the last " +
      "~2 h RainViewer loop; ◉ LIVE returns to the current scan.";
    loadRainViewer();
  } else if (src === "sat") {
    clearFrames();
    setPlaybar(false);
    showSat(opt.getAttribute("data-sat"));
    note.textContent = opt.text.replace(/&deg;/g,"°") +
      " — GOES-East, latest scan (NASA GIBS). Full-disk coverage, updates ~every 10 min.";
    document.getElementById("stamp").textContent = "GOES latest";
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
  sites.forEach(function (s) {
    if (s.lat == null) return;
    var m = L.marker([s.lat, s.lon], { pane:"sites", icon: L.divIcon({
      className: "siteicon " + (s.net === "TDWR" ? "tdwr" : "nexrad"),
      iconSize: [7, 7], iconAnchor: [3.5, 3.5], html: '<span class="sdot"></span>' }) });
    m.bindTooltip(s.id + " — " + s.name, { direction: "top", offset: [0, -5] });
    m.on("click", function () { openSitePopup(s); });
    siteLayer.addLayer(m);
  });
  if (document.getElementById("c-sites").checked && !map.hasLayer(siteLayer)) siteLayer.addTo(map);
}
function openSitePopup(s) {
  var html = '<div class="sitepop"><b>' + s.id + '</b> &middot; ' + s.net + '<br>' + s.name + '<br>' +
    s.lat.toFixed(3) + '&deg;, ' + s.lon.toFixed(3) + '&deg;<br>' +
    '<button class="sp-go">Open this radar</button>' +
    (s.net === "WSR-88D" ? '<button class="sp-3d">3D volume</button>' : '') + '</div>';
  L.popup({ offset: [0, -4] }).setLatLng([s.lat, s.lon]).setContent(html).openOn(map);
  setTimeout(function () {
    var el = document.querySelector(".sitepop"); if (!el) return;
    el.querySelector(".sp-go").onclick = function () { map.closePopup(); selectSite(s); };
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

/* below this zoom, storm tracks/cells clutter into each other — hide Level III entirely
   (and skip the multi-radar fetches). Tracks come from EVERY WSR-88D whose site sits in
   view (up to MAX_L3_SITES nearest the centre), so a whole storm field is covered, not one radar. */
var TRACK_MIN_ZOOM = 7;
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
    renderStorm(res[0], res[1].filter(function (x) { return x.result; }));
  });
}
var loadWarnings = loadStormData;   // back-compat alias

function renderStorm(features, l3List) {
  warnLayer.clearLayers();
  trackLayer.clearLayers();
  cellMarkers.forEach(function (m){ map.removeLayer(m); });
  cellMarkers = []; rowsById = {}; cellRefs = {}; selectedId = null;
  lastL3 = l3List[0] ? l3List[0].result : null;

  var bounds = map.getBounds().pad(0.15);
  var showTracks = map.getZoom() >= TRACK_MIN_ZOOM && document.getElementById("c-tracks").checked;
  var rows = [];

  // 1) Level III cells from every in-view radar (only those within the padded view)
  l3List.forEach(function (entry, si) {
    var res = entry.result;
    if (!res || !res.cells) return;
    res.cells.forEach(function (c) {
      if (c.lat < bounds.getSouth() || c.lat > bounds.getNorth() ||
          c.lon < bounds.getWest() || c.lon > bounds.getEast()) return;
      rows.push({
        key: c.id + "#" + si, id: c.id, site: entry.site.id,
        glyph: "●", cls: "t-cell", threat: "cell", event: "Radar cell · " + entry.site.id,
        hail: null, wind: null, dir: (c.headingToward != null ? compass(c.headingToward) : "—"),
        spd: c.speedKt >= 0 ? c.speedKt : null,
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
      target._poly = poly; target._color = color;
    }
  });

  // 3) markers + forecast tracks + refs
  rows.forEach(function (r) {
    if (!r.glyph) { r.glyph = "●"; r.cls = "t-cell"; r.threat = "cell"; r.event = r.event || "Radar cell"; }
    if (showTracks && r.track && r.track.length && r.center) {
      var tp = [r.center].concat(r.track);
      L.polyline(tp, { pane:"track", color:"#000", weight:4, opacity:0.35 }).addTo(trackLayer);
      L.polyline(tp, { pane:"track", color:"#ffd23f", weight:2, opacity:0.95 }).addTo(trackLayer);
      r.track.forEach(function (pt, i) {
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
      if (document.getElementById("c-cells").checked) marker.addTo(map);
    }
    cellRefs[r.key] = { marker:marker, poly:r._poly || null, color:r._color || "#4a6ea9", center:r.center };
  });

  buildTable(rows);

  var tr = document.getElementById("textreadout");
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
  var body = document.getElementById("tablebody");
  if (!rows.length) {
    body.innerHTML = '<div class="empty">No active severe warnings in the current view. ' +
      'Pan to an area of active weather, or press Reload data. ' +
      '(Table is driven by live NWS warning algorithm output.)</div>';
    return;
  }
  var h = '<table class="storm"><thead><tr>' +
    '<th>ID</th><th>Threat</th><th>Event</th><th>Max Hail (in)</th>' +
    '<th>Max Wind (kt)</th><th>Dir</th><th>Spd (kt)</th><th>Area</th><th>Expires</th>' +
    '</tr></thead><tbody>';
  rows.forEach(function (r) {
    rowsById[r.key] = r;
    h += '<tr data-key="' + r.key + '">' +
      '<td class="id">' + r.id + '</td>' +
      '<td class="ev"><span class="threat ' + r.cls + '">' + r.glyph + "</span> " + r.threat.toUpperCase() + '</td>' +
      '<td class="ev">' + r.event + '</td>' +
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
  var tr = document.querySelector('tr[data-key="' + key + '"]');
  if (tr) tr.classList.toggle("mk-hi", on);
  var ref = cellRefs[key];
  var el = ref && ref.marker && ref.marker.getElement();
  if (el) el.classList.toggle("hi", on);
}

/* persistent selection linking one table row <-> one map cell */
function selectRow(key) {
  selectedId = key;
  document.querySelectorAll("tr[data-key]").forEach(function (tr) {
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

  var selTr = document.querySelector('tr[data-key="' + key + '"]');
  if (selTr) selTr.scrollIntoView({ block:"nearest" });
  // on a phone the map sits above the table - bring it into view so the ping is seen
  if (isMobile()) document.getElementById("mapwrap").scrollIntoView({ behavior:"smooth", block:"start" });
}

/* ============================= HELPERS ============================= */
function pad(n){ return (n<10?"0":"") + n; }
function fmtStamp(d) {
  return d.getUTCFullYear() + "-" + pad(d.getUTCMonth()+1) + "-" + pad(d.getUTCDate()) + " " +
    pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + "Z";
}
function fmtClock(d) { return pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + "Z"; }
function setStatus(t){ document.getElementById("datastatus").textContent = t; }
function setTableStatus(t){ document.getElementById("tablestatus").textContent = t; }

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

document.getElementById("network").addEventListener("change", populateSites);
document.getElementById("findsite").addEventListener("input", populateSites);
document.getElementById("site").addEventListener("change", function () {
  showSiteInfo(); centerOnSite();
  if (isMobile()) {   // close the drawer so the map is visible after picking a site
    document.body.classList.remove("controls-open");
    setTimeout(function () { map.invalidateSize(); }, 260);
  }
});
document.getElementById("recenter").addEventListener("click", centerOnSite);
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
  if (satLayer) satLayer.setOpacity(radarOpacity());
  if (usingFrames && frameLayers.length) showFrame(curFrame);
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
});
document.getElementById("c-tracks").addEventListener("change", function () {
  if (this.checked) trackLayer.addTo(map); else map.removeLayer(trackLayer);
});
document.getElementById("c-iem").addEventListener("change", syncIem);
map.on("zoomend", syncIem);
document.getElementById("c-sites").addEventListener("change", function () {
  if (this.checked) siteLayer.addTo(map); else map.removeLayer(siteLayer);
});

/* storm panel tabs: table <-> raw Level III text */
function showTab(text) {
  document.getElementById("tablebody").style.display = text ? "none" : "";
  document.getElementById("textreadout").style.display = text ? "" : "none";
  document.getElementById("tab-table").classList.toggle("active", !text);
  document.getElementById("tab-text").classList.toggle("active", text);
}
document.getElementById("tab-table").addEventListener("click", function () { showTab(false); });
document.getElementById("tab-text").addEventListener("click", function () { showTab(true); });

document.getElementById("refresh").addEventListener("click", function () {
  var src = document.getElementById("product").options[document.getElementById("product").selectedIndex].getAttribute("data-src");
  if (src === "rv") loadRainViewer();
  if (src === "iem" && iemLayer) { showIem(false); showIem(true); }
  loadWarnings();
});

var moveTimer = null;
map.on("moveend", function () {
  clearTimeout(moveTimer);
  moveTimer = setTimeout(loadWarnings, 500);   // refresh in-view cells after panning
});

/* ============================= BOOT ============================= */
buildLegend();
startClock();
setStatus("Loading radar sites…");
loadStations().then(function () { buildSiteMarkers(); centerOnSite(); });
applyProduct();     // default product = base reflectivity (IEM) live
loadWarnings();

})();
