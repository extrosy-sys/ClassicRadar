/* =====================================================================
   volume3d.js — a WebGL "MRI-like" volumetric storm view.

   Composites the four super-resolution reflectivity tilts (N0B/N1B/N2B/N3B)
   from the nearest NEXRAD into a 3D point cloud: each radar gate becomes a
   point at its true (azimuth, slant-range, elevation) position — converted to
   x/y/z with 4/3-earth beam-height geometry — colored by dBZ. Orbit / zoom /
   pan give full 3D movement. Decoding is 100% client-side (Level3.fetchTilt +
   bzip2), so it also works on GitHub Pages.
   ===================================================================== */
window.Volume3D = (function () {
  "use strict";
  var TILTS = ["N0B", "N1B", "N2B", "N3B"];
  var RAMP = [
    [5, 0x04e9e7], [20, 0x02fd02], [30, 0x008e00], [35, 0xfdf802], [40, 0xe5bc00],
    [45, 0xfd9500], [50, 0xfd0000], [55, 0xbc0000], [65, 0xf800fd], [70, 0x9854c6], [75, 0xffffff]
  ];
  var Re = 8494.0;           // 4/3 earth radius (km)
  var MAX_RANGE_KM = 160;    // focus near the radar

  var el, renderer, scene, camera, controls, cloud, raf, tilts = [];

  function dbzColor(d) {
    var hex = RAMP[0][1];
    for (var i = 0; i < RAMP.length; i++) { if (d >= RAMP[i][0]) hex = RAMP[i][1]; }
    return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
  }

  function open(site3, label) {
    build();
    setStatus("Fetching 4 reflectivity tilts for " + label + " …");
    el.style.display = "flex";
    resize();
    Promise.all(TILTS.map(function (t) { return Level3.fetchTilt(site3, t); }))
      .then(function (res) {
        tilts = res.filter(Boolean);
        if (!tilts.length) { setStatus("No reflectivity data available for " + label + "."); return; }
        var elevs = tilts.map(function (t) { return t.elevation.toFixed(1) + "°"; }).join(", ");
        setStatus(label + " — tilts " + elevs + ". Drag to orbit · scroll to zoom · right-drag to pan.");
        rebuild();
        start();
      })
      .catch(function (e) { setStatus("3D load failed: " + e.message); });
  }

  function rebuild() {
    if (!tilts.length) return;
    var thresh = parseInt(document.getElementById("v3-thresh").value, 10);
    var vex = parseFloat(document.getElementById("v3-vex").value);
    var pos = [], col = [];
    tilts.forEach(function (t) {
      var e = t.elevation * Math.PI / 180, cosE = Math.cos(e), sinE = Math.sin(e);
      var maxG = Math.min(t.nbins, Math.floor(MAX_RANGE_KM / t.gateKm));
      t.radials.forEach(function (rad) {
        var a = rad.az * Math.PI / 180, sinA = Math.sin(a), cosA = Math.cos(a);
        var L = rad.levels, n = Math.min(L.length, maxG);
        for (var g = 0; g < n; g += 2) {
          var v = L[g]; if (v < 2) continue;
          var dbz = 0.5 * v - 33; if (dbz < thresh) continue;
          var rng = (g + 0.5) * t.gateKm;
          var h = Math.sqrt(rng * rng + Re * Re + 2 * rng * Re * sinE) - Re;
          var s = Re * Math.asin(rng * cosE / (Re + h));
          pos.push(s * sinA, h * vex, s * cosA);          // Y-up, vertical exaggeration
          var c = dbzColor(dbz); col.push(c[0], c[1], c[2]);
        }
      });
    });
    if (cloud) { scene.remove(cloud); cloud.geometry.dispose(); cloud.material.dispose(); }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    cloud = new THREE.Points(geo, new THREE.PointsMaterial({ size: 1.4, vertexColors: true, sizeAttenuation: true }));
    scene.add(cloud);
    document.getElementById("v3-count").textContent = (pos.length / 3 | 0).toLocaleString() + " points";
  }

  function build() {
    if (el) return;
    el = document.createElement("div");
    el.id = "vol3d";
    el.innerHTML =
      '<div id="v3-bar">' +
        '<b>VOLUMETRIC STORM &mdash; 3D reflectivity</b>' +
        '<span id="v3-status"></span><span class="v3-sp"></span>' +
        '<label>dBZ&ge; <input type="range" id="v3-thresh" min="5" max="60" value="20"></label>' +
        '<label>V&times; <input type="range" id="v3-vex" min="1" max="12" value="5" step="0.5"></label>' +
        '<span id="v3-count"></span>' +
        '<button id="v3-close">&times; CLOSE</button>' +
      '</div><div id="v3-canvas"></div>';
    document.body.appendChild(el);

    var host = el.querySelector("#v3-canvas");
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0e14);
    camera = new THREE.PerspectiveCamera(55, 1, 1, 4000);
    camera.position.set(180, 150, 180);
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    host.appendChild(renderer.domElement);
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    var grid = new THREE.GridHelper(320, 32, 0x2b4468, 0x1a2740);
    scene.add(grid);
    scene.add(new THREE.AxesHelper(40));
    // radar site marker
    var site = new THREE.Mesh(new THREE.SphereGeometry(2.5, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0xffd23f }));
    scene.add(site);

    document.getElementById("v3-close").onclick = close;
    document.getElementById("v3-thresh").oninput = rebuild;
    document.getElementById("v3-vex").oninput = rebuild;
    window.addEventListener("resize", resize);
    resize();
  }

  function resize() {
    if (!renderer) return;
    var host = el.querySelector("#v3-canvas");
    var w = host.clientWidth, h = host.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }

  function start() { resize(); if (!raf) loop(); }
  function loop() { raf = requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera); }
  function close() { if (raf) cancelAnimationFrame(raf); raf = null; el.style.display = "none"; }
  function setStatus(t) { var s = document.getElementById("v3-status"); if (s) s.textContent = t; }

  return { open: open };
})();
