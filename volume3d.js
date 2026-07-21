/* =====================================================================
   volume3d.js — a WebGL "MRI-like" volumetric storm view.

   Composites the super-resolution radar tilts from the nearest NEXRAD into a
   3D point cloud: each gate becomes a point at its true (azimuth, slant-range,
   elevation) position via 4/3-earth beam-height geometry. Two products, each
   with 4 tilts (0.5/1.3/2.4/3.1°):
     - Reflectivity  N0B/N1B/N2B/N3B  -> dBZ, NWS color ramp
     - Velocity      N0G/N1G/N2G/N3G  -> m/s, green(inbound)/red(outbound)
   A textured map floor (CARTO tiles centered on the radar) grounds the volume.
   100% client-side (Level3.fetchTilt + bzip2), so it works on GitHub Pages too.
   ===================================================================== */
window.Volume3D = (function () {
  "use strict";
  var Re = 8494.0;           // 4/3 earth radius (km)
  var MAX_RANGE_KM = 160;

  var DBZ = [[5,0x04e9e7],[20,0x02fd02],[30,0x008e00],[35,0xfdf802],[40,0xe5bc00],
             [45,0xfd9500],[50,0xfd0000],[55,0xbc0000],[65,0xf800fd],[70,0x9854c6],[75,0xffffff]];

  // product config: tilt product codes, value(level), threshold-test, color(value)
  var PRODUCTS = {
    refl: {
      title: "reflectivity", codes: ["N0B","N1B","N2B","N3B"], unit: "dBZ",
      slider: { min:5, max:65, val:20 },
      value: function (L) { return 0.5 * L - 33; },
      keep: function (L, v, thr) { return L >= 2 && v >= thr; },
      color: function (v) {
        var hex = DBZ[0][1]; for (var i=0;i<DBZ.length;i++) if (v>=DBZ[i][0]) hex=DBZ[i][1];
        return [((hex>>16)&255)/255, ((hex>>8)&255)/255, (hex&255)/255];
      }
    },
    vel: {
      title: "velocity", codes: ["N0G","N1G","N2G","N3G"], unit: "m/s",
      slider: { min:0, max:40, val:8 },
      value: function (L) { return (L - 129) * 0.5; },          // m/s, +away / -toward
      keep: function (L, v, thr) { return L >= 2 && L !== 255 && Math.abs(v) >= thr; },
      color: function (v) {
        var a = Math.min(1, Math.abs(v)/35);
        return v < 0 ? [0.10, 0.35+0.65*a, 0.30] : [0.35+0.65*a, 0.12, 0.12];  // green in / red out
      }
    }
  };

  var el, renderer, scene, camera, controls, cloud, floor, raf, sprite = null;
  var product = "refl", site3 = "", label = "";
  var radars = [];   // [{ tilts, rx, ry, id }] — primary (rx=ry=0) + overlapping neighbours
  var animFrames = [], animIdx = 0, animPlaying = false, animTimer = null;   // temporal loop (primary only)

  /* index each tilt's radials by 0.5° azimuth bucket so adjacent tilts can be interpolated */
  function buildGrid(t) {
    t.grid = {};
    t.radials.forEach(function (r) { t.grid[Math.round(r.az * 2)] = r.levels; });
    return t;
  }
  /* during a temporal loop we show just the primary radar; otherwise every combined radar */
  function activeRadars() {
    if (animFrames.length) return [{ tilts: animFrames[animIdx], rx: 0, ry: 0, id: site3 }];
    return radars;
  }
  function haversineKm(a, b, c, d) {
    var R = 6371, dl = (c-a)*Math.PI/180, dn = (d-b)*Math.PI/180;
    var x = Math.sin(dl/2)*Math.sin(dl/2) + Math.cos(a*Math.PI/180)*Math.cos(c*Math.PI/180)*Math.sin(dn/2)*Math.sin(dn/2);
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
  }
  /* east/north km offset of (lat2,lon2) from (lat1,lon1) */
  function eastNorthKm(lat1, lon1, lat2, lon2) {
    return [ (lon2-lon1) * Math.cos(lat1*Math.PI/180) * 111.32, (lat2-lat1) * 110.574 ];
  }
  /* nearest N other WSR-88D radars within ~260 km (their coverage overlaps the primary's) */
  function nearbyRadars(pSite3, lat, lon, n) {
    var all = window.CR_SITES || [];
    return all.filter(function (s) { return s.net === "WSR-88D" && s.lat != null && Level3.site3(s.id) !== pSite3; })
      .map(function (s) { return { site3: Level3.site3(s.id), d: haversineKm(lat, lon, s.lat, s.lon) }; })
      .filter(function (s) { return s.d < 260; })
      .sort(function (a, b) { return a.d - b.d; })
      .slice(0, n);
  }

  /* soft radial sprite -> each point becomes a fuzzy transparent "blob" (volumetric cloud) */
  function getSprite() {
    if (sprite) return sprite;
    var c = document.createElement("canvas"); c.width = c.height = 64;
    var x = c.getContext("2d"), g = x.createRadialGradient(32,32,0, 32,32,32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.35, "rgba(255,255,255,0.5)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = g; x.fillRect(0,0,64,64);
    sprite = new THREE.CanvasTexture(c); return sprite;
  }

  function makeMaterial() {
    var mode = document.getElementById("v3-mode").value;
    var op = parseInt(document.getElementById("v3-op").value, 10) / 100;
    var size = parseFloat(document.getElementById("v3-size").value);
    if (mode === "blob") {
      return new THREE.PointsMaterial({ size: size * 3.2, map: getSprite(), vertexColors: true,
        transparent: true, opacity: op, depthWrite: false, sizeAttenuation: true });
    }
    return new THREE.PointsMaterial({ size: size, vertexColors: true,
      transparent: op < 0.999, opacity: op, depthWrite: op >= 0.999, sizeAttenuation: true });
  }
  function updateMaterial() {
    if (!cloud) return;
    var old = cloud.material;
    cloud.material = makeMaterial();
    old.dispose();
  }

  /* ---- temporal animation: loop the last K volume scans ---- */
  function updateFidx() { var e = document.getElementById("v3-fidx"); if (e) e.textContent = animFrames.length ? (animIdx+1)+"/"+animFrames.length : ""; }
  function stopAnim() {
    animPlaying = false; if (animTimer) { clearInterval(animTimer); animTimer = null; }
    var b = document.getElementById("v3-play"); if (b) b.textContent = "▶";
  }
  function playAnim() {
    if (animFrames.length < 2) return;
    animPlaying = true; document.getElementById("v3-play").textContent = "❚❚";
    if (animTimer) clearInterval(animTimer);
    animTimer = setInterval(function () { animIdx = (animIdx + 1) % animFrames.length; rebuild(); updateFidx(); }, 700);
  }
  function fetchFrames(K) {
    stopAnim();
    var p = PRODUCTS[product];
    setStatus("Loading " + K + " frames of " + p.title + " for " + label + " …");
    Promise.all(p.codes.map(function (c) { return Level3.latestKeys(site3, c, K); })).then(function (keyArrs) {
      var jobs = [];
      for (var i = 0; i < K; i++) (function (i) {
        jobs.push(Promise.all(p.codes.map(function (c, ci) {
          var arr = keyArrs[ci] || [], key = arr[i];
          return key ? Level3.fetchTiltKey(key) : Promise.resolve(null);
        })).then(function (ts) { return ts.filter(Boolean).map(buildGrid); }));
      })(i);
      Promise.all(jobs).then(function (frames) {
        animFrames = frames.filter(function (f) { return f.length; });
        if (animFrames.length < 2) { setStatus("Not enough recent frames available."); animFrames = []; updateFidx(); return; }
        animIdx = animFrames.length - 1;
        setStatus(label + " — " + animFrames.length + " frames loaded; ▶ to loop.");
        updateFidx(); rebuild(); playAnim();
      });
    }).catch(function (e) { setStatus("Frame load failed: " + e.message); });
  }

  function open(s3, lbl, prod) {
    build();
    product = PRODUCTS[prod] ? prod : "refl";
    site3 = s3; label = lbl || s3;
    document.getElementById("v3-prod").value = product;
    configSlider();
    el.style.display = "flex";
    resize();
    load();
  }

  function fetchRadar(s3) {   // -> array of grid-indexed tilts (or [])
    var p = PRODUCTS[product];
    return Promise.all(p.codes.map(function (c) { return Level3.fetchTilt(s3, c); }))
      .then(function (res) { return res.filter(Boolean).map(buildGrid); });
  }
  function load() {
    stopAnim(); animFrames = []; radars = [];
    var fr = document.getElementById("v3-frames");
    if (fr) { fr.value = "1"; document.getElementById("v3-play").disabled = true; }
    updateFidx();
    var p = PRODUCTS[product];
    setStatus("Fetching " + p.title + " tilts for " + label + " …");
    document.getElementById("v3-title").textContent = "VOLUMETRIC STORM — 3D " + p.title;
    fetchRadar(site3).then(function (primary) {
      if (!primary.length) { setStatus("No " + p.title + " data available for " + label + "."); if (cloud) { scene.remove(cloud); cloud = null; } return; }
      var plat = primary[0].radarLat, plon = primary[0].radarLon;
      radars = [{ tilts: primary, rx: 0, ry: 0, id: site3 }];
      buildFloor(plat, plon);
      rebuild();          // show the primary radar immediately
      start();

      // then pull the nearest overlapping radars and grid them in (fills the cone of silence
      // over each radar + far-side low-altitude gaps a single radar can't see)
      var nbrs = nearbyRadars(site3, plat, plon, 3);
      if (!nbrs.length) return;
      setStatus(label + " — adding " + nbrs.length + " overlapping radar(s) to fill gaps…");
      Promise.all(nbrs.map(function (nb) {
        return fetchRadar(nb.site3).then(function (ts) {
          if (ts.length) {
            var off = eastNorthKm(plat, plon, ts[0].radarLat, ts[0].radarLon);
            radars.push({ tilts: ts, rx: off[0], ry: off[1], id: nb.site3 });
          }
        }).catch(function () {});
      })).then(function () {
        setStatus(label + " — " + radars.length + " radars combined (" +
          radars.map(function (r) { return r.id; }).join(" + ") + "). Overlap fills each radar's cone of silence.");
        rebuild();        // rebuild the volume with every radar max-combined
      });
    }).catch(function (e) { setStatus("3D load failed: " + e.message); });
  }

  var surfaceMeshes = [];
  function clearSurfaces() {
    surfaceMeshes.forEach(function (m) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); });
    surfaceMeshes = [];
  }
  function clearCloud() { if (cloud) { scene.remove(cloud); cloud.geometry.dispose(); cloud.material.dispose(); cloud = null; } }

  /* dispatch: solid isosurfaces (marching cubes) for reflectivity, else point/blob cloud */
  function rebuild() {
    if (document.getElementById("v3-mode").value === "surface" && product === "refl") buildSurfaces();
    else buildPoints();
  }

  /* grid the radar volume onto a Cartesian field, then Marching-Cubes nested isosurfaces */
  function buildSurfaces() {
    clearCloud();
    var rads = activeRadars();
    if (!rads || !rads.length) { clearSurfaces(); return; }
    var p = PRODUCTS[product];
    var thr = parseFloat(document.getElementById("v3-thresh").value);
    var vex = parseFloat(document.getElementById("v3-vex").value);
    var opF = parseInt(document.getElementById("v3-op").value, 10) / 55;

    var R = MAX_RANGE_KM, NE = 104, NN = 104, NH = 28, ZTOP = 16, FLOOR = -32;
    var dE = 2*R/NE, dN = 2*R/NN, dH = ZTOP/NH, Re = 8494, NEN = NE*NN;
    var field = new Float32Array(NE*NN*NH); field.fill(NaN);   // NaN = no radar sees it

    // precompute each radar's sorted tilts + beam trig
    var per = rads.map(function (r) {
      r.tilts.forEach(function (t) { if (!t.grid) buildGrid(t); });
      var st = r.tilts.slice().sort(function (a, b) { return a.elevation - b.elevation; });
      return { rx: r.rx, ry: r.ry, st: st,
        tanE: st.map(function (t) { return Math.tan(t.elevation*Math.PI/180); }),
        cosE: st.map(function (t) { return Math.cos(t.elevation*Math.PI/180); }) };
    });

    for (var ie = 0; ie < NE; ie++) {
      var east = -R + (ie + 0.5) * dE;
      for (var jn = 0; jn < NN; jn++) {
        var north = -R + (jn + 0.5) * dN, base = ie + jn*NE;
        for (var ri = 0; ri < per.length; ri++) {          // each overlapping radar, max-combined
          var Q = per[ri], e2 = east - Q.rx, n2 = north - Q.ry;
          var gr = Math.sqrt(e2*e2 + n2*n2);
          if (gr < 2 || gr > R) continue;                  // this radar can't see this column
          var azKey = Math.round((((Math.atan2(e2, n2)*180/Math.PI) % 360) + 360) % 360 * 2);
          var nT = Q.st.length, bh = new Array(nT), dv = new Array(nT);
          for (var ti = 0; ti < nT; ti++) {
            bh[ti] = gr*Q.tanE[ti] + gr*gr/(2*Re);
            var t = Q.st[ti], g = Math.floor((gr/Q.cosE[ti]) / t.gateKm), lv = t.grid[azKey];
            var s = (lv && g >= 0 && g < lv.length) ? (lv[g] >= 2 ? p.value(lv[g]) : FLOOR) : NaN;
            dv[ti] = (s !== s) ? FLOOR : s;
          }
          for (var kh = 0; kh < NH; kh++) {
            var h = (kh + 0.5) * dH, val;
            if (h <= bh[0]) val = dv[0];                    // extend lowest tilt to the ground
            else if (h >= bh[nT-1]) val = FLOOR;            // above the top beam = this radar's blind cone
            else {
              val = FLOOR;
              for (var b = 0; b < nT - 1; b++) if (h >= bh[b] && h <= bh[b+1]) {
                var f = (h - bh[b]) / (bh[b+1] - bh[b]); val = dv[b] + (dv[b+1] - dv[b]) * f; break;
              }
            }
            var idx = base + kh*NEN, cur = field[idx];
            if (cur !== cur || val > cur) field[idx] = val;  // max dBZ across radars fills the blind cones
          }
        }
      }
    }

    function map(gx, gy, gz) {
      return [ -R + (gx + 0.5) * dE, ((gz + 0.5) * dH) * vex, -R + (gy + 0.5) * dN ];
    }
    // adaptive nested levels: spread from the threshold up to (near) the field's actual peak,
    // so the innermost shell always lands on the storm core (red/magenta) whatever its strength.
    var fmax = FLOOR;
    for (var fi = 0; fi < field.length; fi++) { var fv = field[fi]; if (fv === fv && fv > fmax) fmax = fv; }
    var lo = thr, hi = Math.max(thr + 10, fmax - 2);
    var levels = [0, 0.4, 0.7, 0.92].map(function (f) { return lo + (hi - lo) * f; });

    clearSurfaces();
    var ops = [0.12, 0.26, 0.52, 0.97], verts = 0;
    levels.forEach(function (lvl, i) {
      var pos = [];
      MarchingCubes.build(field, NE, NN, NH, lvl, map, pos);
      if (!pos.length) return;
      verts += pos.length / 3;
      var geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.computeVertexNormals();
      var c = p.color(lvl), op = Math.min(1, ops[i] * opF);
      var mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(c[0], c[1], c[2]),
        transparent: op < 0.95, opacity: op, side: THREE.DoubleSide, depthWrite: op >= 0.9 });
      var mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = levels.length - i;
      mesh.userData.baseOp = ops[i];
      surfaceMeshes.push(mesh); scene.add(mesh);
    });
    document.getElementById("v3-count").textContent = (verts | 0).toLocaleString() + " verts · peak " + fmax.toFixed(0) + " dBZ";
  }
  function setSurfaceOpacity() {
    var opF = parseInt(document.getElementById("v3-op").value, 10) / 55;
    surfaceMeshes.forEach(function (m) {
      var op = Math.min(1, m.userData.baseOp * opF);
      m.material.opacity = op; m.material.transparent = op < 0.95; m.material.depthWrite = op >= 0.9;
    });
  }

  function buildPoints() {
    clearSurfaces();
    var rads = activeRadars();
    if (!rads || !rads.length) return;
    var p = PRODUCTS[product];
    var thr = parseFloat(document.getElementById("v3-thresh").value);
    var vex = parseFloat(document.getElementById("v3-vex").value);
    var fill = parseInt(document.getElementById("v3-fill").value, 10) || 0;
    var pos = [], col = [];
    function plot(rx, ry, azDeg, g, gateKm, lv, sinE, cosE) {
      var val = p.value(lv); if (!p.keep(lv, val, thr)) return;
      var rng = (g + 0.5) * gateKm;
      var h = Math.sqrt(rng*rng + Re*Re + 2*rng*Re*sinE) - Re;
      var s = Re * Math.asin(rng*cosE/(Re+h));
      var a = azDeg*Math.PI/180;
      pos.push(rx + s*Math.sin(a), h*vex, ry + s*Math.cos(a));   // offset by the radar's own location
      var c = p.color(val); col.push(c[0], c[1], c[2]);
    }
    rads.forEach(function (rad) {
      var ts = rad.tilts;
      ts.forEach(function (t) { if (!t.grid) buildGrid(t); });
      // real tilt slices
      ts.forEach(function (t) {
        var e = t.elevation*Math.PI/180, sinE = Math.sin(e), cosE = Math.cos(e);
        var maxG = Math.min(t.nbins, Math.floor(MAX_RANGE_KM / t.gateKm));
        t.radials.forEach(function (radial) {
          var n = Math.min(radial.levels.length, maxG);
          for (var g = 0; g < n; g += 2) { var lv = radial.levels[g]; if (lv >= 2) plot(rad.rx, rad.ry, radial.az, g, t.gateKm, lv, sinE, cosE); }
        });
      });
      // overlapping interpolated slices between adjacent tilts (fills the vertical gaps)
      if (fill > 0 && ts.length > 1) {
        var sorted = ts.slice().sort(function (a, b) { return a.elevation - b.elevation; });
        for (var i = 0; i < sorted.length - 1; i++) {
          var t0 = sorted[i], t1 = sorted[i+1], gk = t0.gateKm;
          var maxG = Math.min(t0.nbins, t1.nbins, Math.floor(MAX_RANGE_KM / gk));
          for (var k = 1; k <= fill; k++) {
            var frac = k / (fill + 1);
            var elev = t0.elevation + (t1.elevation - t0.elevation) * frac;
            var e2 = elev*Math.PI/180, sinE2 = Math.sin(e2), cosE2 = Math.cos(e2);
            for (var azKey in t0.grid) {
              var l1 = t1.grid[azKey]; if (!l1) continue;
              var l0 = t0.grid[azKey], az = azKey / 2;
              for (var g2 = 0; g2 < maxG; g2 += 3) {
                var v0 = l0[g2], v1 = l1[g2]; if (v0 < 2 || v1 < 2) continue;
                plot(rad.rx, rad.ry, az, g2, gk, v0 + (v1 - v0) * frac, sinE2, cosE2);
              }
            }
          }
        }
      }
    });
    if (cloud) { scene.remove(cloud); cloud.geometry.dispose(); cloud.material.dispose(); }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    cloud = new THREE.Points(geo, makeMaterial());
    cloud.renderOrder = 2;
    scene.add(cloud);
    document.getElementById("v3-count").textContent = (pos.length/3 | 0).toLocaleString() + " pts";
  }

  /* textured map floor: CARTO tiles covering the ~320 km box, stitched to a canvas */
  function buildFloor(lat, lon) {
    if (floor) { scene.remove(floor); floor.material.map && floor.material.map.dispose(); floor.geometry.dispose(); floor = null; }
    if (lat == null || isNaN(lat)) return;
    var Z = 8, world = 256 * Math.pow(2, Z);
    var cx = (lon + 180) / 360 * world;
    var s = Math.sin(lat*Math.PI/180);
    var cy = (0.5 - Math.log((1+s)/(1-s)) / (4*Math.PI)) * world;
    var kmPerPx = 156543.03392 * Math.cos(lat*Math.PI/180) / Math.pow(2, Z) / 1000;
    var halfPx = MAX_RANGE_KM / kmPerPx;
    var minTx = Math.floor((cx-halfPx)/256), maxTx = Math.floor((cx+halfPx)/256);
    var minTy = Math.floor((cy-halfPx)/256), maxTy = Math.floor((cy+halfPx)/256);
    var nx = maxTx-minTx+1, ny = maxTy-minTy+1;
    var cv = document.createElement("canvas"); cv.width = nx*256; cv.height = ny*256;
    var ctx = cv.getContext("2d"); ctx.fillStyle = "#c8c8c8"; ctx.fillRect(0,0,cv.width,cv.height);
    var tex = new THREE.CanvasTexture(cv);
    var done = 0, total = nx*ny;
    for (var ty = minTy; ty <= maxTy; ty++) for (var tx = minTx; tx <= maxTx; tx++) {
      (function (tx, ty) {
        var im = new Image(); im.crossOrigin = "anonymous";
        im.onload = function () { ctx.drawImage(im, (tx-minTx)*256, (ty-minTy)*256); if (++done>=total) tex.needsUpdate = true; };
        im.onerror = function () { if (++done>=total) tex.needsUpdate = true; };
        im.src = "https://a.basemaps.cartocdn.com/rastertiles/voyager/"+Z+"/"+tx+"/"+ty+".png";
      })(tx, ty);
    }
    // explicit ground quad in world coords (X=east, Z=north, Y=0) with UVs pinned to the map,
    // so orientation is unambiguous: north=+Z, east=+X, text upright (no mirror).
    var offX = cx - minTx*256, offY = cy - minTy*256;
    var Xmin = -offX * kmPerPx, Xmax = (cv.width - offX) * kmPerPx;   // west / east edges
    var Zmax = offY * kmPerPx, Zmin = -(cv.height - offY) * kmPerPx;  // north / south edges
    var Y = -0.15;
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([
      Xmin, Y, Zmax,  Xmax, Y, Zmax,  Xmin, Y, Zmin,  Xmax, Y, Zmin ], 3)); // NW,NE,SW,SE
    geo.setAttribute("uv", new THREE.Float32BufferAttribute([ 1,1,  0,1,  1,0,  0,0 ], 2));
    geo.setIndex([0, 2, 3, 0, 3, 1]);
    geo.computeVertexNormals();
    floor = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
    scene.add(floor);
  }

  function configSlider() {
    var p = PRODUCTS[product], sl = document.getElementById("v3-thresh");
    sl.min = p.slider.min; sl.max = p.slider.max; sl.value = p.slider.val;
    document.getElementById("v3-thlab").textContent = p.unit + "≥";
  }

  function build() {
    if (el) return;
    el = document.createElement("div"); el.id = "vol3d";
    el.innerHTML =
      '<div id="v3-bar">' +
        '<b id="v3-title">VOLUMETRIC STORM — 3D reflectivity</b>' +
        '<label>Product <select id="v3-prod"><option value="refl">Reflectivity (dBZ)</option>' +
          '<option value="vel">Velocity (m/s)</option></select></label>' +
        '<label>Mode <select id="v3-mode"><option value="point">Points</option>' +
          '<option value="blob">Blobs</option><option value="surface">Surfaces</option></select></label>' +
        '<span id="v3-status"></span><span class="v3-sp"></span>' +
        '<label><span id="v3-thlab">dBZ≥</span> <input type="range" id="v3-thresh" min="5" max="65" value="20"></label>' +
        '<label>Opac <input type="range" id="v3-op" min="8" max="100" value="55"></label>' +
        '<label>Size <input type="range" id="v3-size" min="1" max="10" value="2" step="0.5"></label>' +
        '<label>V× <input type="range" id="v3-vex" min="1" max="12" value="5" step="0.5"></label>' +
        '<label>Fill <select id="v3-fill"><option>0</option><option selected>1</option><option>2</option></select></label>' +
        '<label>Frames <select id="v3-frames"><option value="1" selected>1</option><option value="4">4</option>' +
          '<option value="8">8</option></select></label>' +
        '<button id="v3-play" disabled>▶</button><span id="v3-fidx"></span>' +
        '<span id="v3-count"></span>' +
        '<button id="v3-close">× CLOSE</button>' +
      '</div><div id="v3-canvas"></div>';
    document.body.appendChild(el);

    var host = el.querySelector("#v3-canvas");
    scene = new THREE.Scene(); scene.background = new THREE.Color(0x0a0e14);
    camera = new THREE.PerspectiveCamera(55, 1, 1, 6000);
    camera.position.set(40, 165, -235);   // view from the SOUTH looking north, so map labels read upright
    renderer = new THREE.WebGLRenderer({ antialias:true, preserveDrawingBuffer:true });
    host.appendChild(renderer.domElement);
    controls = new THREE.OrbitControls(camera, renderer.domElement); controls.enableDamping = true;

    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    var dl = new THREE.DirectionalLight(0xffffff, 0.7); dl.position.set(0.4, 1, 0.3); scene.add(dl);
    var dl2 = new THREE.DirectionalLight(0xbcd0ff, 0.35); dl2.position.set(-0.5, 0.4, -0.6); scene.add(dl2);
    scene.add(new THREE.GridHelper(320, 16, 0x2b4468, 0x14202f));
    var site = new THREE.Mesh(new THREE.SphereGeometry(2, 12, 12), new THREE.MeshBasicMaterial({ color:0xffd23f }));
    scene.add(site);

    document.getElementById("v3-close").onclick = close;
    document.getElementById("v3-thresh").oninput = rebuild;
    document.getElementById("v3-vex").oninput = rebuild;
    function applyStyle() {
      if (document.getElementById("v3-mode").value === "surface" && product === "refl") setSurfaceOpacity();
      else updateMaterial();
    }
    document.getElementById("v3-op").oninput = applyStyle;          // live, no geometry rebuild
    document.getElementById("v3-size").oninput = applyStyle;
    document.getElementById("v3-mode").onchange = rebuild;          // switching in/out of surfaces rebuilds
    document.getElementById("v3-fill").onchange = rebuild;
    document.getElementById("v3-frames").onchange = function () {
      var k = parseInt(this.value, 10);
      document.getElementById("v3-play").disabled = k < 2;
      if (k > 1) fetchFrames(k);
      else { stopAnim(); animFrames = []; updateFidx(); rebuild(); }
    };
    document.getElementById("v3-play").onclick = function () { animPlaying ? stopAnim() : playAnim(); };
    document.getElementById("v3-prod").onchange = function () { product = this.value; configSlider(); load(); };
    window.addEventListener("resize", resize);
    resize();
  }

  function resize() {
    if (!renderer) return;
    var host = el.querySelector("#v3-canvas");
    var w = host.clientWidth, h = host.clientHeight;
    renderer.setSize(w, h); camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix();
  }
  function start() { resize(); if (!raf) loop(); }
  function loop() { raf = requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera); }
  function close() { if (raf) cancelAnimationFrame(raf); raf = null; el.style.display = "none"; }
  function setStatus(t) { var s = document.getElementById("v3-status"); if (s) s.textContent = t; }

  return { open: open };
})();
