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

function clearFrames() {
  frameLayers.forEach(function (l) { map.removeLayer(l); });
  frameLayers = []; frameTimes = [];
}
function showIem(on) {
  if (on && !iemLayer) {
    iemLayer = L.tileLayer(IEM_URL, { pane:"radar", opacity:radarOpacity(), maxZoom:18, maxNativeZoom:14,
      noWrap:true, zIndex:20, attribution:"Base reflectivity &copy; Iowa Environmental Mesonet" }).addTo(map);
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
        var lyr = L.tileLayer(url, { pane:"radar", opacity:0, maxZoom:18, maxNativeZoom:7, noWrap:true,
          attribution:"Radar &copy; RainViewer" }).addTo(map);
        frameLayers.push(lyr);
        frameTimes.push(f.time);
      });
      curFrame = frameLayers.length - 1;
      wireScrub();
      showFrame(curFrame);
      return true;
    });
}

function showFrame(i) {
  if (!frameLayers.length) return;
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
    setPlaybar(true);
    note.textContent = opt.text.replace(/&deg;/g,"°") +
      " — animated loop of the last ~2 h (RainViewer, ~2 km mosaic; pixelates when zoomed past ~z7). " +
      "For crisp detail when zoomed in, tick “IEM true-dBZ” below.";
    loadRainViewer();
  } else { // unavail (velocity / VIL / echo tops - single-site products)
    clearFrames();
    setPlaybar(false);
    note.textContent = opt.text.replace(/&deg;/g,"°") +
      " — single-site Level III product, not in the free national loop feeds. Reflectivity products animate; storm attributes below come from Level III.";
    document.getElementById("stamp").textContent = "product n/a";
  }
}
function setPlaybar(on) {
  ["pp","step-b","step-f","scrub"].forEach(function (id) {
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

/* Fetch NWS warnings (event-filtered so the relevant ones aren't truncated) plus the
   nearest NEXRAD's live Level III storm-track product, then render both together. */
function loadStormData() {
  setTableStatus("querying NWS + Level III…");
  var c = map.getCenter();
  var site = nearestSite(c.lat, c.lng);
  var warnP = fetch(WARN_URL, { headers:{ "Accept":"application/geo+json" } })
    .then(function (r) { return r.ok ? r.json() : { features: [] }; })
    .then(function (j) { return j.features || []; })
    .catch(function () { return []; });
  var l3P = site ? Level3.fetchStormTrack(Level3.site3(site.id)) : Promise.resolve(null);
  return Promise.all([warnP, l3P]).then(function (res) { renderStorm(res[0], res[1], site); });
}
var loadWarnings = loadStormData;   // back-compat alias

function renderStorm(features, l3, site) {
  warnLayer.clearLayers();
  trackLayer.clearLayers();
  cellMarkers.forEach(function (m){ map.removeLayer(m); });
  cellMarkers = []; rowsById = {}; cellRefs = {}; selectedId = null;
  lastL3 = l3;

  var bounds = map.getBounds().pad(0.15);
  var rows = [];

  // 1) Level III tracked cells: real id / position / motion / forecast track
  if (l3 && l3.cells) l3.cells.forEach(function (c) {
    rows.push({
      id: c.id, glyph: "●", cls: "t-cell", threat: "cell", event: "Radar cell",
      hail: null, wind: null,
      dir: (c.headingToward != null ? compass(c.headingToward) : "—"),
      spd: c.speedKt >= 0 ? c.speedKt : null,
      area: "", expires: null, center: [c.lat, c.lon], track: c.forecast, tvs: false
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
      target = { id: cellId(rows.length), center: cen, track: [] };
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
    if (r.track && r.track.length && r.center && document.getElementById("c-tracks").checked) {
      var tp = [r.center].concat(r.track);
      L.polyline(tp, { pane:"track", color:"#000", weight:4, opacity:0.35 }).addTo(trackLayer);   // shadow
      L.polyline(tp, { pane:"track", color:"#ffd23f", weight:2, opacity:0.95 }).addTo(trackLayer); // track
      r.track.forEach(function (pt, i) {
        L.circleMarker(pt, { pane:"track", radius:2.6, color:"#ffd23f", weight:1.5,
          fillColor:"#1a1a1a", fillOpacity:1 }).addTo(trackLayer);                                 // time hash
        L.marker(pt, { pane:"track", icon: L.divIcon({ className:"trktick",
          html:((i + 1) * 15) + "′", iconSize:[0,0] }) }).addTo(trackLayer);                       // 15/30/45/60 min
      });
    }
    var marker = null;
    if (r.center) {
      marker = L.marker(r.center, { pane:"cells", icon: L.divIcon({
        className:"cellmark-wrap", iconSize:[0,0],
        html:'<span class="cellmark ' + r.cls + '">' + r.glyph + " " + r.id + "</span>" }) });
      (function (rid) {
        marker.on("click", function(){ selectRow(rid); });
        marker.on("mouseover", function(){ hoverCell(rid, true); });
        marker.on("mouseout", function(){ hoverCell(rid, false); });
      })(r.id);
      cellMarkers.push(marker);
      if (document.getElementById("c-cells").checked) marker.addTo(map);
    }
    cellRefs[r.id] = { marker:marker, poly:r._poly || null, color:r._color || "#4a6ea9", center:r.center };
  });

  buildTable(rows);

  var tr = document.getElementById("textreadout");
  if (l3 && l3.rawText && l3.rawText.trim()) {
    tr.textContent = "Site " + (site ? site.id : "?") + "   product " + l3.productCode +
      "   volume " + l3.volTime + "\n\n" + l3.rawText;
  } else {
    tr.textContent = "No Level III storm-track text for " + (site ? site.id : "this area") +
      " right now — the radar's SCIT algorithm isn't tracking discrete cells.\n" +
      "The table above is populated from live NWS warning tags.";
  }

  var l3n = (l3 && l3.cells) ? l3.cells.length : 0;
  setTableStatus(rows.length + " cell(s) · " + l3n + " Level III · " +
    (site ? site.id : "?") + (l3 && l3.volTime ? " vol " + l3.volTime : "") +
    " · " + fmtStamp(new Date()).slice(11));
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
    rowsById[r.id] = r;
    h += '<tr data-id="' + r.id + '">' +
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
  body.querySelectorAll("tr[data-id]").forEach(function (tr) {
    var rid = tr.getAttribute("data-id");
    tr.addEventListener("click", function () { selectRow(rid); });
    tr.addEventListener("mouseenter", function () { hoverCell(rid, true); });
    tr.addEventListener("mouseleave", function () { hoverCell(rid, false); });
  });
}
function isMobile() { return window.matchMedia("(max-width: 760px)").matches; }

/* transient highlight of a cell's row + marker on hover (either direction) */
function hoverCell(id, on) {
  var tr = document.querySelector('tr[data-id="' + id + '"]');
  if (tr) tr.classList.toggle("mk-hi", on);
  var ref = cellRefs[id];
  var el = ref && ref.marker && ref.marker.getElement();
  if (el) el.classList.toggle("hi", on);
}

/* persistent selection linking one table row <-> one map cell */
function selectRow(id) {
  selectedId = id;
  document.querySelectorAll("tr[data-id]").forEach(function (tr) {
    tr.classList.toggle("sel", tr.getAttribute("data-id") === id);
  });
  // reset every marker/polygon, then emphasize the chosen one
  Object.keys(cellRefs).forEach(function (k) {
    var ref = cellRefs[k];
    var el = ref.marker && ref.marker.getElement();
    if (el) el.classList.remove("sel");
    if (ref.poly) ref.poly.setStyle({ weight:2.5, fillOpacity:0.15 });
  });
  var ref = cellRefs[id];
  if (ref) {
    var el = ref.marker && ref.marker.getElement();
    if (el) el.classList.add("sel");
    if (ref.poly) ref.poly.setStyle({ weight:4, fillOpacity:0.38, color:ref.color });
  }
  var r = rowsById[id];
  if (r && r.center) map.flyTo(r.center, Math.max(map.getZoom(), 8), { duration:0.6 });

  var selTr = document.querySelector('tr[data-id="' + id + '"]');
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

document.getElementById("pp").addEventListener("click", function () { playing ? pause() : play(); });
document.getElementById("step-f").addEventListener("click", function () { pause(); showFrame(curFrame + 1); });
document.getElementById("step-b").addEventListener("click", function () { pause(); showFrame(curFrame - 1); });
document.getElementById("scrub").addEventListener("input", function () { pause(); showFrame(parseInt(this.value, 10)); });

document.getElementById("opacity").addEventListener("input", function () {
  if (iemLayer) iemLayer.setOpacity(radarOpacity());
  if (frameLayers.length) showFrame(curFrame);
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
document.getElementById("c-iem").addEventListener("change", function () {
  showIem(this.checked);
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
loadStations().then(centerOnSite);
applyProduct();     // default product = base reflectivity (IEM) live
loadWarnings();

})();
