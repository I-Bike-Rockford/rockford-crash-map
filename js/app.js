/* Rockford Crash Map. An initiative of I Bike Rockford.
   Static site: Leaflet + two JSON files built from Illinois DOT crash data (2006-2025). */
(function () {
  'use strict';
  var CFG = Object.assign({ GOOGLE_STREETVIEW_KEY: '', MAPBOX_TOKEN: '', MAPBOX_STYLE: '', CONTACT_EMAIL: 'ibikerockford@gmail.com' }, window.CRASHMAP_CONFIG || {});

  var COLOR = { ped: '#C8553D', bike: '#2A7F8E', veh: '#5B5F97' };
  var MODE_KEY = ['veh', 'ped', 'bike'];            // data value m: 0 other, 1 pedestrian, 2 bicycle
  var MODE_PRI = { 1: 0, 2: 1, 0: 2 };              // which mode wins when crashes share a point
  var MODE_LABEL = ['Motor vehicle', 'Person walking', 'Person bicycling'];
  var SEV_NAME = ['Fatal', 'Serious injury', 'Minor injury', 'Possible injury', 'No injury'];
  var HOUR_LABELS = ['12–3 am', '3–6 am', '6–9 am', '9 am–12', '12–3 pm', '3–6 pm', '6–9 pm', '9 pm–12', 'Unknown'];
  var Y0 = 2006, Y1 = 2025;

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var fmt = function (n) { return Number(n).toLocaleString('en-US'); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }

  /* ---------- state ---------- */
  var S = { mode: 'all', sev: new Set([0, 1]), years: new Set(), hours: new Set(), showOut: true, countOut: false, extent: false };
  var rows = [], LUT = null, otherLoaded = false, otherLoading = false;
  var groups = new Map(), lastView = [];
  var map, kaLayer, dotLayer, canvas, baseLayers = {}, currentBase = null;

  /* ---------- url state ---------- */
  function readQuery() {
    var q = new URLSearchParams(location.search);
    if (q.get('m') && ['all', 'ped', 'bike', 'veh'].indexOf(q.get('m')) > -1) S.mode = q.get('m');
    if (q.get('s')) { S.sev = new Set(q.get('s').split('').map(Number).filter(function (n) { return n >= 0 && n <= 4; })); if (!S.sev.size) S.sev = new Set([0, 1]); }
    if (q.get('y')) q.get('y').split(',').map(Number).forEach(function (y) { if (y >= Y0 && y <= Y1) S.years.add(y); });
    if (q.get('h')) q.get('h').split(',').map(Number).forEach(function (h) { if (h >= 0 && h <= 8) S.hours.add(h); });
    if (q.get('o') === '0') S.showOut = false;
    if (q.get('c') === '1') S.countOut = true;
  }
  function writeQuery() {
    var q = new URLSearchParams();
    if (S.mode !== 'all') q.set('m', S.mode);
    var s = Array.from(S.sev).sort().join(''); if (s !== '01') q.set('s', s);
    if (S.years.size) q.set('y', Array.from(S.years).sort().join(','));
    if (S.hours.size) q.set('h', Array.from(S.hours).sort().join(','));
    if (!S.showOut) q.set('o', '0');
    if (S.countOut) q.set('c', '1');
    var qs = q.toString();
    try { history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash); } catch (e) { }
  }

  /* ---------- data ---------- */
  function expand(j) {
    var n = j.id.length, out = new Array(n);
    LUT = j.meta.lut;
    for (var i = 0; i < n; i++) {
      out[i] = { id: j.id[i], y: j.y[i], mo: j.mo[i], d: j.d[i], h: j.h[i], s: j.s[i], k: j.k[i], i: j.i[i], v: j.v[i], m: j.m[i],
        co: j.co[i], li: j.li[i], wx: j.wx[i], su: j.su[i], hr: j.hr[i], st: j.st[i], at: j.at[i], lat: j.lat[i], lon: j.lon[i], ci: j.ci[i], p: j.p[i] };
    }
    return out;
  }
  function getJSON(url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); }); }
  function loadOther() {
    if (otherLoaded || otherLoading) return Promise.resolve();
    otherLoading = true; $('#loading').hidden = false;
    return getJSON('data/other.json').then(function (j) { rows = rows.concat(expand(j)); otherLoaded = true; })
      .catch(function () { $('#status').textContent = 'Could not load minor and no-injury crashes. Check your connection and try again.'; S.sev = new Set(Array.from(S.sev).filter(function (x) { return x <= 1; })); })
      .then(function () { otherLoading = false; $('#loading').hidden = true; });
  }

  /* ---------- filtering ---------- */
  function hourBucket(h) { return h < 0 ? 8 : Math.floor(h / 3); }
  function passes(r, skip) {
    if (!S.sev.has(r.s)) return false;
    if (S.mode !== 'all' && MODE_KEY[r.m] !== S.mode) return false;
    if (!S.showOut && !r.ci && !S.countOut) return false;
    if (skip !== 'y' && S.years.size && !S.years.has(r.y)) return false;
    if (skip !== 'h' && S.hours.size && !S.hours.has(hourBucket(r.h))) return false;
    return true;
  }
  function inExtent(r, b) { return !S.extent || !b || b.contains([r.lat, r.lon]); }
  function counted(r) { return r.ci || S.countOut; }

  /* ---------- marker drawing ---------- */
  function shape(mode, size, s) {
    var fill = COLOR[MODE_KEY[mode]], stroke = s === 0 ? '#111' : '#fff', sw = s === 0 ? 3 : 2, g;
    if (mode === 1) g = '<circle cx="15" cy="15" r="11" fill="' + fill + '" stroke="' + stroke + '" stroke-width="' + sw + '"/>';
    else if (mode === 2) g = '<polygon points="15,2.5 27.5,15 15,27.5 2.5,15" fill="' + fill + '" stroke="' + stroke + '" stroke-width="' + sw + '" stroke-linejoin="round"/>';
    else g = '<rect x="4.5" y="4.5" width="21" height="21" rx="4.5" fill="' + fill + '" stroke="' + stroke + '" stroke-width="' + sw + '"/>';
    if (s === 0) g += '<circle cx="15" cy="15" r="3.6" fill="#fff"/>';
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 30 30" aria-hidden="true">' + g + '</svg>';
  }
  function makeIcon(g) {
    var z = map ? map.getZoom() : 12, k = z <= 11 ? 0 : z <= 13 ? 1 : z <= 15 ? 2 : 3;
    var size = g.s === 0 ? [15, 20, 26, 32][k] : [11, 15, 20, 24][k];
    var html = shape(g.m, size, g.s) + (g.list.length > 1 ? '<span class="badge">' + g.list.length + '</span>' : '');
    return L.divIcon({ className: 'cm' + (g.ci ? '' : ' out'), html: html, iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2] });
  }
  function dateText(r) {
    return new Date(r.y, r.mo - 1, r.d).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }
  function hourText(h) {
    if (h < 0) return 'time not recorded';
    var h12 = (h % 12) || 12, ap = h < 12 ? 'am' : 'pm';
    return h12 + ':00–' + h12 + ':59 ' + ap;
  }
  function locText(r) {
    var st = r.st || '', at = r.at || '';
    if (st && at) {
      if (at.toLowerCase().indexOf(st.toLowerCase()) === 0) return at.replace(/\//g, ' & ');
      return st + ' at ' + at.replace(/\//g, ' & ');
    }
    return st || at.replace(/\//g, ' & ');
  }
  function titleOf(r) {
    if (r.s === 0) return r.k > 1 ? r.k + ' people killed' : (r.k === 1 ? 'Person killed' : 'Fatal crash');
    return SEV_NAME[r.s] + ' crash';
  }
  function labelOf(g) {
    var r = g.list[0];
    return (g.list.length > 1 ? g.list.length + ' crashes at this location, worst: ' + SEV_NAME[g.s].toLowerCase() : SEV_NAME[g.s] + ' crash') + ', ' + MODE_LABEL[g.m].toLowerCase() + ', ' + r.y;
  }

  /* ---------- popups ---------- */
  function svSetup(root, lat, lon) {
    var key = CFG.GOOGLE_STREETVIEW_KEY; if (!key) return;
    var box = $('.sv', root); if (!box) return;
    var loc = lat + ',' + lon;
    fetch('https://maps.googleapis.com/maps/api/streetview/metadata?location=' + loc + '&source=outdoor&key=' + encodeURIComponent(key))
      .then(function (r) { return r.json(); })
      .then(function (m) {
        if (m.status !== 'OK') return;
        var img = new Image(); img.alt = 'Street View of the crash location (image date may differ from crash date)';
        img.src = 'https://maps.googleapis.com/maps/api/streetview?size=480x280&fov=80&source=outdoor&location=' + loc + '&key=' + encodeURIComponent(key);
        img.onload = function () { box.appendChild(img); };
      }).catch(function () { });
  }
  function cardHTML(r, first) {
    var h = '<h3>' + esc(titleOf(r)) + ' <span class="tag ' + MODE_KEY[r.m] + '">' + MODE_LABEL[r.m] + '</span></h3>';
    h += '<p class="when">' + esc(dateText(r)) + ' · ' + esc(hourText(r.h)) + '</p>';
    if (r.st || r.at) h += '<p class="where">' + esc(locText(r)) + '</p>';
    var dl = '';
    function add(k, v) { if (v) dl += '<dt>' + k + '</dt><dd>' + esc(v) + '</dd>'; }
    add('Collision', LUT.coll[r.co]);
    if (r.i > 0) add('People injured', String(r.i));
    if (r.v > 0) add('Vehicles', String(r.v));
    add('Lighting', LUT.light[r.li]);
    add('Weather', LUT.wx[r.wx]);
    add('Road surface', LUT.surf[r.su]);
    if (r.hr === 1) add('Hit and run', 'Yes');
    h += '<dl>' + dl + '</dl>';
    if (r.p) {
      h += '<div class="persons"><b>People killed</b>' + r.p.split('; ').map(function (x) { return esc(x); }).join('<br>') +
        '<small>From the federal FARS database, matched to this crash. No names.</small></div>';
    }
    if (!r.ci) h += '<p class="grp">Outside the current Rockford city limits (IDOT lists this crash as Rockford).</p>';
    if (first) h += '<div class="sv"></div>';
    var sv = 'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=' + r.lat + ',' + r.lon;
    h += '<div class="links"><a href="' + sv + '" target="_blank" rel="noopener">Open in Google Street View</a>' +
      '<a href="mailto:' + CFG.CONTACT_EMAIL + '?subject=' + encodeURIComponent('Crash ' + r.id) + '">Report a problem</a></div>';
    return h;
  }
  var SHOW_STEP = 12;
  function openGroup(g, latlng) {
    var list = g.list.slice().sort(function (a, b) { return a.s - b.s || (b.y - a.y) || (b.mo - a.mo) || (b.d - a.d); });
    var shown = Math.min(SHOW_STEP, list.length);
    var el = document.createElement('div'); el.className = 'pop'; L.DomEvent.disableClickPropagation(el);
    function paint() {
      var html = '';
      if (list.length > 1) html += '<p class="grp"><b>' + list.length + ' crashes</b> are recorded at this point. IDOT often places crashes at the center of an intersection.</p>';
      for (var i = 0; i < shown; i++) { if (i) html += '<hr>'; html += cardHTML(list[i], i === 0 && list.length === 1); }
      if (shown < list.length) html += '<hr><button type="button" class="btn small" data-more>Show ' + Math.min(SHOW_STEP, list.length - shown) + ' more (' + (list.length - shown) + ' left)</button>';
      el.innerHTML = html;
      var b = $('[data-more]', el); if (b) b.addEventListener('click', function (e) { e.stopPropagation(); shown = Math.min(shown + SHOW_STEP, list.length); paint(); });
      if (list.length === 1) svSetup(el, g.lat, g.lon);
    }
    paint();
    var narrow = window.innerWidth <= 820;
    L.popup({ maxWidth: 340, autoPanPaddingTopLeft: [16, 70], autoPanPaddingBottomRight: [16, narrow ? 150 : 24], closeButton: true })
      .setLatLng(latlng || [g.lat, g.lon]).setContent(el).openOn(map);
  }

  /* ---------- render ---------- */
  var renderTimer = null;
  function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(render, 60); }
  function tally(list) {
    var t = { n: 0, fatal: 0, killed: 0, serious: 0, ped: 0, bike: 0 };
    for (var i = 0; i < list.length; i++) {
      var r = list[i]; t.n++;
      if (r.s === 0) { t.fatal++; t.killed += r.k; } else if (r.s === 1) t.serious++;
      if (r.m === 1) t.ped++; else if (r.m === 2) t.bike++;
    }
    return t;
  }
  function render() {
    var b = map ? map.getBounds() : null;
    var view = [], counts = [];
    groups = new Map();
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!passes(r)) continue;
      view.push(r);
      if (counted(r) && inExtent(r, b)) counts.push(r);
      var key = r.lat + ',' + r.lon, g = groups.get(key);
      if (!g) { g = { lat: r.lat, lon: r.lon, list: [], s: 9, m: 0, ci: r.ci, key: key }; groups.set(key, g); }
      g.list.push(r);
      if (r.s < g.s || (r.s === g.s && MODE_PRI[r.m] < MODE_PRI[g.m])) { g.s = r.s; g.m = r.m; }
    }
    lastView = view;
    kaLayer.clearLayers(); dotLayer.clearLayers();
    var kaMarks = [], dots = [];
    groups.forEach(function (g) {
      if (g.s <= 1) {
        var m = L.marker([g.lat, g.lon], { icon: makeIcon(g), keyboard: true, title: labelOf(g), zIndexOffset: (4 - g.s) * 1000 + (g.list.length > 1 ? 100 : 0) });
        m.on('click', function () { openGroup(g); });
        m.on('add', function () { var e = m.getElement(); if (e) { e.setAttribute('aria-label', labelOf(g) + '. Press Enter for details.'); e.setAttribute('role', 'button'); e.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openGroup(g); } }); } });
        kaMarks.push(m);
      } else {
        var c = L.circleMarker([g.lat, g.lon], { renderer: canvas, radius: (g.s === 2 ? 3.5 : 2.5) + (map.getZoom() >= 15 ? 1.5 : 0) + (g.list.length > 1 ? 1.5 : 0), weight: 0.5, color: '#fff', fillColor: COLOR[MODE_KEY[g.m]], fillOpacity: g.ci ? 0.6 : 0.2 });
        c.on('click', function (e) { L.DomEvent.stopPropagation(e); openGroup(g, e.latlng); });
        dots.push(c);
      }
    });
    dots.forEach(function (c) { dotLayer.addLayer(c); });
    kaMarks.forEach(function (m) { kaLayer.addLayer(m); });
    updatePanel(counts);
    writeQuery();
  }

  /* ---------- panel ---------- */
  function updatePanel(counts) {
    var t = tally(counts);
    $('#t-n').textContent = fmt(t.n); $('#t-fatal').textContent = fmt(t.fatal); $('#t-killed').textContent = fmt(t.killed);
    $('#t-serious').textContent = fmt(t.serious); $('#t-ped').textContent = fmt(t.ped); $('#t-bike').textContent = fmt(t.bike);
    var st = t.n ? fmt(t.n) + ' crashes shown: ' + fmt(t.fatal) + ' fatal, ' + fmt(t.serious) + ' serious injury.' : 'No crashes match these filters.';
    if (S.extent) st += ' Counting only the current map view.';
    $('#status').textContent = st;
    $('#sheet-summary').textContent = t.n ? fmt(t.n) + ' crashes · ' + fmt(t.killed) + ' killed · Filters' : 'No crashes match · Filters';
    $('#empty').hidden = t.n > 0 || lastView.length > 0;
    drawBars('years', 'y', Y0, Y1);
    drawBars('hours', 'h', 0, 8);
  }
  function drawBars(id, kind, lo, hi) {
    var b = map ? map.getBounds() : null, data = {}, i, r;
    for (i = lo; i <= hi; i++) data[i] = [0, 0, 0];
    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      if (!passes(r, kind) || !counted(r) || !inExtent(r, b)) continue;
      var k = kind === 'y' ? r.y : hourBucket(r.h);
      data[k][r.s === 0 ? 0 : r.s === 1 ? 1 : 2]++;
    }
    var max = 1; for (i = lo; i <= hi; i++) max = Math.max(max, data[i][0] + data[i][1] + data[i][2]);
    var set = kind === 'y' ? S.years : S.hours, el = $('#bars-' + id), html = '';
    for (i = lo; i <= hi; i++) {
      var d = data[i], tot = d[0] + d[1] + d[2], pressed = set.has(i);
      var lab = kind === 'y' ? String(i) : HOUR_LABELS[i];
      var name = kind === 'y' ? String(i).slice(2) : ['12a', '3a', '6a', '9a', '12p', '3p', '6p', '9p', '?'][i];
      html += '<button type="button" class="bar' + (set.size && !pressed ? ' dim' : '') + '" data-k="' + i + '" aria-pressed="' + pressed + '" aria-label="' + esc(lab) + ': ' + d[0] + ' fatal, ' + d[1] + ' serious injury' + (d[2] ? ', ' + d[2] + ' other' : '') + ' crashes">' +
        '<span class="stk"><i class="o" style="height:' + (d[2] / max * 84) + 'px;background:#d9d5cb"></i><i class="a" style="height:' + (d[1] / max * 84) + 'px"></i><i class="k" style="height:' + (d[0] / max * 84) + 'px"></i></span><em>' + name + '</em></button>';
    }
    el.innerHTML = html;
  }

  /* ---------- table view ---------- */
  var tableShown = 300;
  function openTable() {
    var list = lastView.slice().sort(function (a, b) { return (b.y - a.y) || (b.mo - a.mo) || (b.d - a.d) || (a.s - b.s); });
    var v = $('#tview'); v.hidden = false; document.body.style.overflow = 'hidden';
    function paint() {
      var n = Math.min(tableShown, list.length), h = '<div class="row" style="margin:4px 0 12px"><button type="button" class="btn" id="t-close">Back to map</button><span class="status">' + fmt(list.length) + ' crashes match your filters (the same crashes shown on the map, including faded ones outside city limits). Showing ' + fmt(n) + '.</span></div>';
      h += '<table><caption class="sr">Crashes matching current filters</caption><thead><tr><th>Date</th><th>Time</th><th>Severity</th><th>Mode</th><th>Killed</th><th>Location</th><th>Collision</th><th>In city limits</th><th>Map</th></tr></thead><tbody>';
      for (var i = 0; i < n; i++) {
        var r = list[i];
        h += '<tr><td>' + r.y + '-' + String(r.mo).padStart(2, '0') + '-' + String(r.d).padStart(2, '0') + '</td><td>' + esc(r.h < 0 ? '—' : r.h + ':00') + '</td><td>' + SEV_NAME[r.s] + '</td><td>' + MODE_LABEL[r.m] + '</td><td>' + (r.k || '') + '</td><td>' + esc(locText(r) || 'Not recorded') + '</td><td>' + esc(LUT.coll[r.co] || '') + '</td><td>' + (r.ci ? 'Yes' : 'No') + '</td><td><button type="button" data-go="' + i + '" aria-label="Show on map: ' + esc(titleOf(r)) + ', ' + r.y + '-' + r.mo + '-' + r.d + '">Show</button></td></tr>';
      }
      h += '</tbody></table>';
      if (n < list.length) h += '<p><button type="button" class="btn" id="t-more">Show ' + Math.min(300, list.length - n) + ' more</button></p>';
      v.innerHTML = h;
      $('#t-close').addEventListener('click', closeTable);
      var mb = $('#t-more'); if (mb) mb.addEventListener('click', function () { tableShown += 300; paint(); });
      $$('[data-go]', v).forEach(function (b) { b.addEventListener('click', function () { var r = list[+b.getAttribute('data-go')]; closeTable(); map.setView([r.lat, r.lon], 18); var g = groups.get(r.lat + ',' + r.lon); if (g) setTimeout(function () { openGroup(g); }, 250); }); });
      $('#t-close').focus();
    }
    tableShown = 300; paint();
  }
  function closeTable() { $('#tview').hidden = true; document.body.style.overflow = ''; $('#btn-table').focus(); }

  /* ---------- controls ---------- */
  function syncControls() {
    $$('#modes button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.mode === S.mode)); });
    $$('#sevs button').forEach(function (b) { b.setAttribute('aria-pressed', String(S.sev.has(+b.dataset.s))); });
    $('#sw-out').checked = S.showOut; $('#sw-count').checked = S.countOut; $('#sw-extent').checked = S.extent;
    $$('#bases button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.base === currentBase)); });
    $('#sevnote').hidden = otherLoaded;
  }
  function wire() {
    $('#modes').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; S.mode = b.dataset.mode; syncControls(); scheduleRender(); });
    $('#sevs').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return; var s = +b.dataset.s;
      if (S.sev.has(s)) { if (S.sev.size > 1) S.sev.delete(s); } else S.sev.add(s);
      syncControls();
      if (S.sev.has(2) || S.sev.has(3) || S.sev.has(4)) loadOther().then(function () { syncControls(); render(); }); else render();
    });
    $('#bars-years').addEventListener('click', function (e) { var b = e.target.closest('.bar'); if (!b) return; var y = +b.dataset.k; if (S.years.has(y)) S.years.delete(y); else S.years.add(y); render(); });
    $('#bars-hours').addEventListener('click', function (e) { var b = e.target.closest('.bar'); if (!b) return; var h = +b.dataset.k; if (S.hours.has(h)) S.hours.delete(h); else S.hours.add(h); render(); });
    $('#yr-all').addEventListener('click', function () { S.years.clear(); S.hours.clear(); render(); });
    $('#yr-5').addEventListener('click', function () { S.years = new Set([2021, 2022, 2023, 2024, 2025]); render(); });
    $('#sw-out').addEventListener('change', function (e) { S.showOut = e.target.checked; render(); });
    $('#sw-count').addEventListener('change', function (e) { S.countOut = e.target.checked; render(); });
    $('#sw-extent').addEventListener('change', function (e) { S.extent = e.target.checked; render(); });
    $('#btn-reset').addEventListener('click', resetFilters);
    $('#empty-reset').addEventListener('click', resetFilters);
    $('#btn-table').addEventListener('click', openTable);
    $('#bases').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; setBase(b.dataset.base); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#tview').hidden) closeTable(); });
    // bottom sheet
    var panel = $('#panel'), handle = $('#sheet-handle');
    function setOpen(o) { panel.dataset.open = String(o); handle.setAttribute('aria-expanded', String(o)); }
    handle.addEventListener('click', function () { if (!dragMoved) setOpen(panel.dataset.open !== 'true'); });
    var sy = 0, dragMoved = false, startOpen = false;
    handle.addEventListener('pointerdown', function (e) { sy = e.clientY; dragMoved = false; startOpen = panel.dataset.open === 'true'; handle.setPointerCapture(e.pointerId); });
    handle.addEventListener('pointermove', function (e) { if (!handle.hasPointerCapture(e.pointerId)) return; if (Math.abs(e.clientY - sy) > 10) dragMoved = true; });
    handle.addEventListener('pointerup', function (e) { if (dragMoved) { var dy = e.clientY - sy; if (dy < -20) setOpen(true); else if (dy > 20) setOpen(false); setTimeout(function () { dragMoved = false; }, 0); } });
    // search
    $('#search').addEventListener('submit', function (e) {
      e.preventDefault(); var q = $('#q').value.trim(), msg = $('#search-msg'); if (!q) return;
      msg.hidden = false; msg.textContent = 'Searching…';
      fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&viewbox=-89.30,42.40,-88.85,42.12&bounded=1&q=' + encodeURIComponent(q + ', Rockford, IL'))
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (!res.length) { msg.textContent = 'No match in the Rockford area. Try a street and number.'; return; }
          var p = [+res[0].lat, +res[0].lon]; map.setView(p, 17); msg.hidden = true;
          if (window._srch) map.removeLayer(window._srch);
          window._srch = L.circleMarker(p, { radius: 9, color: '#1f2328', weight: 3, fillColor: '#fff', fillOpacity: 1 }).addTo(map).bindTooltip(res[0].display_name.split(',').slice(0, 2).join(','), { permanent: false });
        }).catch(function () { msg.textContent = 'Search is unavailable right now.'; });
      setTimeout(function () { if (msg.textContent.indexOf('Searching') < 0) msg.hidden = true; }, 6000);
    });
  }
  function resetFilters() { S.mode = 'all'; S.sev = new Set([0, 1]); S.years.clear(); S.hours.clear(); S.showOut = true; S.countOut = false; S.extent = false; syncControls(); render(); }

  /* ---------- map ---------- */
  function setBase(k) {
    if (currentBase && baseLayers[currentBase]) map.removeLayer(baseLayers[currentBase]);
    currentBase = k; baseLayers[k].addTo(map); baseLayers[k].bringToBack(); store('rcm-base', k); syncControls();
  }
  function initMap() {
    canvas = L.canvas({ padding: 0.5 });
    map = L.map('map', { zoomControl: false, preferCanvas: true, minZoom: 10, maxZoom: 19, maxBounds: [[41.95, -89.65], [42.55, -88.55]], maxBoundsViscosity: 0.7, keyboard: true });
    var zoomCtl = L.control.zoom({ position: 'topright' }).addTo(map);
    var cartoLight = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { subdomains: 'abcd', maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>' });
    baseLayers.light = cartoLight;
    if (CFG.MAPBOX_TOKEN && CFG.MAPBOX_STYLE) {
      // "Light" is the Mapbox Light style when a token is configured; it falls back to CARTO Light if Mapbox tiles fail to load.
      var mb = L.tileLayer('https://api.mapbox.com/styles/v1/' + CFG.MAPBOX_STYLE + '/tiles/{z}/{x}/{y}?access_token=' + encodeURIComponent(CFG.MAPBOX_TOKEN), { tileSize: 512, zoomOffset: -1, maxZoom: 19, attribution: '&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' });
      var okTiles = 0, badTiles = 0;
      mb.on('tileload', function () { okTiles++; });
      mb.on('tileerror', function () {
        badTiles++;
        if (badTiles >= 4 && okTiles === 0 && currentBase === 'light' && baseLayers.light === mb) { map.removeLayer(mb); baseLayers.light = cartoLight; cartoLight.addTo(map); cartoLight.bringToBack(); }
      });
      baseLayers.light = mb;
    }
    baseLayers.sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles &copy; Esri, Maxar, Earthstar Geographics' });
    var saved = store('rcm-base'); setBase(saved && baseLayers[saved] ? saved : 'light');
    dotLayer = L.layerGroup().addTo(map); kaLayer = L.layerGroup().addTo(map);
    map.setView([42.2711, -89.094], window.innerWidth < 820 ? 11 : 12);
    var locCtl = L.control({ position: 'topright' });
    locCtl.onAdd = function () {
      var bar = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
      var la = L.DomUtil.create('a', 'locate-btn', bar);
      la.href = '#'; la.title = 'Show my location'; la.setAttribute('role', 'button'); la.setAttribute('aria-label', 'Show my location');
      la.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4"/></svg>';
      L.DomEvent.disableClickPropagation(bar);
      L.DomEvent.on(la, 'click', function (ev) { L.DomEvent.preventDefault(ev); map.locate({ setView: false, maxZoom: 16 }); });
      return bar;
    };
    locCtl.addTo(map);
    map.on('locationfound', function (e) {
      var ok = e.latlng.lat > 42.1 && e.latlng.lat < 42.45 && e.latlng.lng > -89.4 && e.latlng.lng < -88.8;
      if (!ok) { $('#status').textContent = 'Your location is outside the Rockford area.'; return; }
      map.setView(e.latlng, 16); if (window._me) map.removeLayer(window._me); window._me = L.circleMarker(e.latlng, { radius: 8, color: '#fff', weight: 3, fillColor: '#1a56db', fillOpacity: 1 }).addTo(map);
    });
    map.on('locationerror', function () { $('#status').textContent = 'Could not get your location.'; });
    map.on('zoomend', scheduleRender);
    var mt; map.on('moveend', function () { if (S.extent) { clearTimeout(mt); mt = setTimeout(render, 150); } });
  }

  /* ---------- views ---------- */
  var VIEW_TITLES = { about: 'About the data', data: 'Data', contact: 'Contact' };
  function route() {
    var h = location.hash.replace('#', ''), v = VIEW_TITLES[h] ? h : '';
    $$('.view').forEach(function (s) { s.hidden = s.id !== 'view-' + v; });
    document.body.classList.toggle('is-map', !v);
    $$('.nav a').forEach(function (a) { a.removeAttribute('aria-current'); if (a.getAttribute('data-v') === v) a.setAttribute('aria-current', 'page'); });
    document.title = (v ? VIEW_TITLES[v] + ' · ' : '') + 'Rockford Crash Map';
    $('#panel').hidden = !!v;
    if (v) { var s = $('#view-' + v); s.scrollTop = 0; var h1 = $('h1', s); if (h1) { h1.setAttribute('tabindex', '-1'); h1.focus({ preventScroll: true }); } }
    else if (map) setTimeout(function () { map.invalidateSize(); }, 0);
  }

  /* ---------- init ---------- */
  function init() {
    readQuery();
    initMap(); wire(); syncControls(); route();
    window.addEventListener('hashchange', route);
    var need = S.sev.has(2) || S.sev.has(3) || S.sev.has(4);
    getJSON('data/ka.json').then(function (j) {
      rows = expand(j);
      var pts = rows.filter(function (r) { return r.ci; }).map(function (r) { return [r.lat, r.lon]; });
      if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.04), { paddingBottomRight: [0, window.innerWidth <= 820 ? 130 : 0] });
      return need ? loadOther() : null;
    }).then(function () { syncControls(); render(); })
      .catch(function () { $('#status').textContent = 'The crash data could not be loaded. If you opened this file directly from your computer, run it from a web server instead.'; });
  }
  document.addEventListener('DOMContentLoaded', init);
})();
