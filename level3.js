/* =====================================================================
   level3.js — client-side NEXRAD Level III (NIDS) reader for the free
   Unidata AWS bucket (which sends Access-Control-Allow-Origin: *, so the
   browser can fetch + decode it directly — no backend needed).

   Verified pipeline (matches the Android/Kotlin decoder & a real KTLX NST):
     strip WMO/AWIPS text header -> zlib inflate (pako) -> scan past the comm
     wrapper for the Message Header Block -> read radar lat/lon, product code,
     volume time -> extract the Tabular Alphanumeric Block (storm text) -> for
     the Storm Track product (NST, code 58) parse each cell's az/range (-> lat/
     lon), motion (deg-from/kt) and 15/30/45/60-min forecast track.
   ===================================================================== */
window.Level3 = {
  BUCKET: "https://unidata-nexrad-level3.s3.amazonaws.com/",

  /** KXXX -> XXX (NEXRAD); TDWR/other ids pass through. */
  site3: function (id) {
    return (id && id.length === 4 && id[0] === "K") ? id.substring(1) : id;
  },

  /** newest key for site+product, walking today back a few UTC days */
  latestKey: function (site3, product) {
    var self = this;
    function ymd(d) { return d.getUTCFullYear() + "_" + p2(d.getUTCMonth() + 1) + "_" + p2(d.getUTCDate()); }
    function tryDay(off) {
      if (off > 3) return Promise.resolve(null);
      var d = new Date(Date.now() - off * 86400000);
      var prefix = site3 + "_" + product + "_" + ymd(d);
      return fetch(self.BUCKET + "?list-type=2&prefix=" + prefix + "&max-keys=1000")
        .then(function (r) { return r.ok ? r.text() : ""; })
        .then(function (xml) {
          var keys = (xml.match(/<Key>([^<]+)<\/Key>/g) || [])
            .map(function (k) { return k.replace(/<\/?Key>/g, ""); });
          return keys.length ? keys[keys.length - 1] : tryDay(off + 1);
        })
        .catch(function () { return tryDay(off + 1); });
    }
    return tryDay(0);
  },

  /** fetch + decode the latest Storm Track (NST) product for a NEXRAD site3 */
  fetchStormTrack: function (site3) {
    var self = this;
    return this.latestKey(site3, "NST").then(function (key) {
      if (!key) return null;
      return fetch(self.BUCKET + key)
        .then(function (r) { return r.ok ? r.arrayBuffer() : null; })
        .then(function (buf) { return buf ? self.decode(new Uint8Array(buf)) : null; });
    }).catch(function () { return null; });
  },

  /** Fetch + decode one super-res reflectivity tilt (N0B/N1B/N2B/N3B) for a 3D volume.
      Returns { elevation(deg), gateKm, nbins, radials:[{az, levels:Uint8Array}] } or null. */
  fetchTilt: function (site3, product) {
    var self = this;
    return this.latestKey(site3, product).then(function (key) {
      if (!key) return null;
      return fetch(self.BUCKET + key)
        .then(function (r) { return r.ok ? r.arrayBuffer() : null; })
        .then(function (buf) { return buf ? self.decodeReflectivity(new Uint8Array(buf)) : null; });
    }).catch(function () { return null; });
  },

  /** dBZ from a digital reflectivity level (product 153/94): 0.5*level - 33, else null. */
  levelToDbz: function (v) { return v >= 2 ? 0.5 * v - 33 : null; },

  decodeReflectivity: function (data) {
    if (typeof window.bzip2 === "undefined") return null;
    var body = this._inflate(data);                 // N?B: MHB/PDB uncompressed
    var mhb = this._findMHB(body);
    if (mhb < 0) return null;
    var dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    var elevation = dv.getInt16(mhb + 18 + (21 - 1) * 2) / 10;   // PDB hw21 = elevation *0.1
    var bz = this._find3(body, mhb + 120, 0x42, 0x5a, 0x68);     // "BZh"
    if (bz < 0) return null;
    var sym;
    try { sym = window.bzip2.simple(window.bzip2.array(body.subarray(bz))); }
    catch (e) { return null; }
    var sv = new DataView(sym.buffer, sym.byteOffset, sym.byteLength);
    // symbology: FFFF 0001 len(4) nlayers(2) FFFF len(4) -> packet at 16
    var pk = 16;
    if (sv.getUint16(pk) !== 16) {                  // relocate if header size differs
      for (var q = 8; q < 40; q++) { if (sv.getUint16(q) === 16 && sv.getUint16(q + 12) > 300) { pk = q; break; } }
    }
    var nbins = sv.getUint16(pk + 4);
    var nrad = sv.getUint16(pk + 12);
    var rp = pk + 14, radials = [];
    for (var r = 0; r < nrad; r++) {
      var nbytes = sv.getUint16(rp);
      var az = sv.getUint16(rp + 2) / 10;
      radials.push({ az: az, levels: sym.subarray(rp + 6, rp + 6 + nbytes) });
      rp += 6 + nbytes;
    }
    return { elevation: elevation, gateKm: 0.25, nbins: nbins, radials: radials };
  },

  _find3: function (b, from, a, c, d) {
    for (var i = Math.max(0, from); i < b.length - 2; i++)
      if (b[i] === a && b[i + 1] === c && b[i + 2] === d) return i;
    return -1;
  },

  decode: function (data) {
    var body = this._inflate(data);
    var mhb = this._findMHB(body);
    if (mhb < 0) return null;
    var dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    var radarLat = dv.getInt32(mhb + 20) / 1000;
    var radarLon = dv.getInt32(mhb + 24) / 1000;
    var prod = dv.getInt16(mhb + 30);
    var volDate = dv.getInt16(mhb + 40);
    var volTime = dv.getInt32(mhb + 42);
    var raw = this._tabular(body, mhb, dv);
    var cells = (prod === 58) ? this._parseNST(raw, radarLat, radarLon) : [];
    return {
      radarLat: radarLat, radarLon: radarLon, productCode: prod,
      volTime: this._volTime(volDate, volTime), cells: cells, rawText: raw
    };
  },

  dest: function (lat, lon, brg, nm) {
    var R = 3440.065, d = nm / R, b = brg * Math.PI / 180;
    var la1 = lat * Math.PI / 180, lo1 = lon * Math.PI / 180;
    var la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
    var lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1),
                               Math.cos(d) - Math.sin(la1) * Math.sin(la2));
    return [la2 * 180 / Math.PI, lo2 * 180 / Math.PI];
  },

  // ---- internals ----
  _inflate: function (data) {
    var z = -1, w = Math.min(80, data.length - 1);
    for (var i = 0; i < w; i++) {
      if (data[i] === 0x78) { var n = data[i + 1]; if (n === 0x01 || n === 0x9c || n === 0xda) { z = i; break; } }
    }
    if (z < 0) return data;
    try { var out = pako.inflate(data.subarray(z)); return out.length > 60 ? out : data; }
    catch (e) { return data; }
  },

  _findMHB: function (b) {
    var dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    for (var o = 0; o < b.length - 120; o++) {
      if (dv.getInt16(o + 18) === -1 && dv.getInt16(o) === dv.getInt16(o + 30)) {
        var code = dv.getInt16(o), lat = dv.getInt32(o + 20) / 1000, lon = dv.getInt32(o + 24) / 1000;
        if (code >= 16 && code < 300 && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) return o;
      }
    }
    return -1;
  },

  _tabular: function (b, from, dv) {
    var tab = -1;
    for (var p = from; p < b.length - 4; p++) {
      if (dv.getInt16(p) === -1 && dv.getUint16(p + 2) === 3) { tab = p; break; }
    }
    var start = tab >= 0 ? tab : from, out = "", line = "";
    for (var i = start; i < b.length; i++) {
      var c = b[i];
      if (c >= 0x20 && c <= 0x7e) line += String.fromCharCode(c);
      else { if (line.length >= 4) out += line + "\n"; line = ""; }
    }
    if (line.length >= 4) out += line;
    return out;
  },

  _parseNST: function (text, rLat, rLon) {
    var out = [], seen = {}, self = this;
    var idRe = /\b([A-Z]\d{1,2})\b/;
    text.split("\n").forEach(function (line) {
      var idm = idRe.exec(line);
      if (!idm) return;
      var id = idm[1], pairs = [], m;
      // integer az/range pairs only — the (?<![\d.]) / (?![\d.]) guards exclude the
      // trailing decimal "error" column (e.g. "1.0/ 1.0") that otherwise parsed as a
      // bogus ~0-range forecast point, drawing a track straight back to the radar.
      var re = /(?<![\d.])(\d{1,3})\s*\/\s*(\d{1,3})(?![\d.])/g;
      while ((m = re.exec(line))) pairs.push([parseInt(m[1], 10), parseInt(m[2], 10)]);
      if (pairs.length < 2) return;
      var az = pairs[0][0], ran = pairs[0][1], mvd = pairs[1][0], mvs = pairs[1][1];
      if (az > 360 || ran > 460 || mvd > 360 || mvs > 200) return;
      if (seen[id]) return; seen[id] = 1;
      var pos = self.dest(rLat, rLon, az, ran);
      var cell = {
        id: id, lat: pos[0], lon: pos[1], az: az, ran: ran,
        movFromDeg: mvd, speedKt: mvs, headingToward: (mvd + 180) % 360, forecast: []
      };
      pairs.slice(2, 6).forEach(function (fp) {
        if (fp[0] <= 360 && fp[1] <= 460) cell.forecast.push(self.dest(rLat, rLon, fp[0], fp[1]));
      });
      out.push(cell);
    });
    return out;
  },

  _volTime: function (days, secs) {
    try {
      var d = new Date(((days - 1) * 86400 + secs) * 1000);
      return d.getUTCFullYear() + "-" + p2(d.getUTCMonth() + 1) + "-" + p2(d.getUTCDate()) +
        " " + p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes()) + "Z";
    } catch (e) { return ""; }
  }
};

function p2(n) { return (n < 10 ? "0" : "") + n; }
