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

  var el, renderer, scene, camera, controls, cloud, floor, raf;
  var tilts = [], product = "refl", site3 = "", label = "";

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

  function load() {
    var p = PRODUCTS[product];
    setStatus("Fetching 4 " + p.title + " tilts for " + label + " …");
    document.getElementById("v3-title").textContent = "VOLUMETRIC STORM — 3D " + p.title;
    Promise.all(p.codes.map(function (c) { return Level3.fetchTilt(site3, c); }))
      .then(function (res) {
        tilts = res.filter(Boolean);
        if (!tilts.length) { setStatus("No " + p.title + " data available for " + label + "."); if (cloud) { scene.remove(cloud); cloud = null; } return; }
        setStatus(label + " — tilts " + tilts.map(function (t){return t.elevation.toFixed(1)+"°";}).join(", ") +
          ". Drag orbit · scroll zoom · right-drag pan.");
        buildFloor(tilts[0].radarLat, tilts[0].radarLon);
        rebuild();
        start();
      })
      .catch(function (e) { setStatus("3D load failed: " + e.message); });
  }

  function rebuild() {
    if (!tilts.length) return;
    var p = PRODUCTS[product];
    var thr = parseFloat(document.getElementById("v3-thresh").value);
    var vex = parseFloat(document.getElementById("v3-vex").value);
    var pos = [], col = [];
    tilts.forEach(function (t) {
      var e = t.elevation*Math.PI/180, cosE = Math.cos(e), sinE = Math.sin(e);
      var maxG = Math.min(t.nbins, Math.floor(MAX_RANGE_KM / t.gateKm));
      t.radials.forEach(function (rad) {
        var a = rad.az*Math.PI/180, sinA = Math.sin(a), cosA = Math.cos(a);
        var Lv = rad.levels, n = Math.min(Lv.length, maxG);
        for (var g = 0; g < n; g += 2) {
          var lv = Lv[g]; if (lv < 2) continue;
          var val = p.value(lv); if (!p.keep(lv, val, thr)) continue;
          var rng = (g + 0.5) * t.gateKm;
          var h = Math.sqrt(rng*rng + Re*Re + 2*rng*Re*sinE) - Re;
          var s = Re * Math.asin(rng*cosE/(Re+h));
          pos.push(s*sinA, h*vex, s*cosA);
          var c = p.color(val); col.push(c[0], c[1], c[2]);
        }
      });
    });
    if (cloud) { scene.remove(cloud); cloud.geometry.dispose(); cloud.material.dispose(); }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    cloud = new THREE.Points(geo, new THREE.PointsMaterial({ size:1.4, vertexColors:true, sizeAttenuation:true }));
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
        im.src = "https://a.basemaps.cartocdn.com/light_nolabels/"+Z+"/"+tx+"/"+ty+".png";
      })(tx, ty);
    }
    var planeW = cv.width * kmPerPx, planeH = cv.height * kmPerPx;
    floor = new THREE.Mesh(new THREE.PlaneGeometry(planeW, planeH),
      new THREE.MeshBasicMaterial({ map:tex, transparent:true, opacity:0.9, depthWrite:false, side:THREE.DoubleSide }));
    floor.rotation.x = Math.PI/2;   // lay flat: image north -> +Z, east -> +X
    var offX = cx - minTx*256, offY = cy - minTy*256;
    floor.position.set((cv.width/2 - offX) * kmPerPx, -0.15, (offY - cv.height/2) * kmPerPx);
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
        '<span id="v3-status"></span><span class="v3-sp"></span>' +
        '<label><span id="v3-thlab">dBZ≥</span> <input type="range" id="v3-thresh" min="5" max="65" value="20"></label>' +
        '<label>V× <input type="range" id="v3-vex" min="1" max="12" value="5" step="0.5"></label>' +
        '<span id="v3-count"></span>' +
        '<button id="v3-close">× CLOSE</button>' +
      '</div><div id="v3-canvas"></div>';
    document.body.appendChild(el);

    var host = el.querySelector("#v3-canvas");
    scene = new THREE.Scene(); scene.background = new THREE.Color(0x0a0e14);
    camera = new THREE.PerspectiveCamera(55, 1, 1, 6000);
    camera.position.set(180, 150, 180);
    renderer = new THREE.WebGLRenderer({ antialias:true, preserveDrawingBuffer:true });
    host.appendChild(renderer.domElement);
    controls = new THREE.OrbitControls(camera, renderer.domElement); controls.enableDamping = true;

    scene.add(new THREE.GridHelper(320, 16, 0x2b4468, 0x14202f));
    var site = new THREE.Mesh(new THREE.SphereGeometry(2, 12, 12), new THREE.MeshBasicMaterial({ color:0xffd23f }));
    scene.add(site);

    document.getElementById("v3-close").onclick = close;
    document.getElementById("v3-thresh").oninput = rebuild;
    document.getElementById("v3-vex").oninput = rebuild;
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
