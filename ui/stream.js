/* Tobiya Hub 0.4.7 — Live cast window.
   One tile per online headset, each painting ONE eye filled edge-to-edge with a
   uniform scale (no stretching — see drawEyeFrame in cast-player.js). Click a
   tile to enlarge it alone; its controls move to the bottom bar. */

const S = {
  settings: {},
  devices: [],
  tiles: new Map(),      // serial -> {el, canvas, player, det, live, stopped}
  order: [],             // serials in grid order
  selected: new Set(),   // ctrl+click selection
  focus: null,
  recording: new Map(),  // serial -> startedAt
  recBusy: new Set(),
  thumbBusy: new Set(),
};

const devBy = (serial) => S.devices.find((d) => d.serial === serial);
const label = (serial) => { const d = devBy(serial); return d?.name || d?.model || serial; };
const shownSerials = () => S.devices.filter((d) => d.state === 'device' && d.withinLicense !== false).map((d) => d.serial);

/** Who the dock / panels act on: the enlarged headset, else the ctrl+click selection, else everyone. */
function targets() {
  if (S.focus) return [S.focus];
  const sel = S.order.filter((s) => S.selected.has(s));
  return sel.length ? sel : [...S.order];
}
function targetLabel() {
  const t = targets();
  if (t.length === 1) return label(t[0]);
  return S.selected.size && !S.focus ? `${t.length} selected` : `All ${t.length} online`;
}

/* ---------------- painting ---------------- */

function cropFor(w, stereo) {
  const one = S.settings.singleEye !== false && stereo !== false;
  return { sx: one && S.settings.castEye === 'right' ? w / 2 : 0, sw: one ? w / 2 : w };
}
const viewOpts = () => ({ fit: S.settings.castFit === 'fit' ? 'fit' : 'fill', trim: S.settings.castTrim || 0 });

/* ---------------- tiles ---------------- */

function topHtml(serial) {
  const d = devBy(serial) || {};
  const t = S.tiles.get(serial);
  const live = t?.live && !t?.stopped;
  const rec = S.recording.has(serial);
  return `<span class="lp ${live ? 'r' : 'wait'}">${live ? `${ic('dot')}LIVE` : t?.stopped ? 'PAUSED' : 'CONNECTING'}</span>
    ${rec ? `<span class="lp rec" data-rt="${esc(serial)}">${ic('rec')}REC ${mmss((Date.now() - S.recording.get(serial)) / 1000)}</span>` : ''}
    <span class="n">${esc(label(serial))}${d.model && d.name ? ` · ${esc(d.model)}` : ''}</span>
    <span class="lp">${ic(d.isWifi ? 'wifi' : 'plug')}</span>
    <span class="lp ${d.battery != null && d.battery < 20 ? 'low' : ''}">${ic('headset')}${d.battery ?? '--'}%</span>`;
}

function buildTile(serial) {
  const el = document.createElement('div');
  el.className = 'lt';
  el.dataset.serial = serial;
  el.innerHTML = `<canvas></canvas><div class="msg">connecting…</div><div class="ot"></div><div class="flash"></div>
    <div class="ob">
      <button class="ib" data-a="shot" title="Save a screenshot to Files">${ic('camera')}Screenshot</button>
      <button class="ib rec" data-a="rec" title="Record this headset">${ic('rec')}<span>Rec</span></button>
      <button class="ib" data-a="home" title="Home">${ic('home')}</button>
      <button class="ib" data-a="big" title="Enlarge">${ic('expand')}</button>
    </div>`;
  el.addEventListener('click', (e) => {
    const b = e.target.closest('.ib');
    if (b) {
      const a = b.dataset.a;
      if (a === 'shot') screenshot(serial);
      else if (a === 'rec') toggleRec(serial);
      else if (a === 'home') sendKey([serial], 3, 'Home');
      else if (a === 'big') setFocus(serial);
      return;
    }
    if (S.focus) return;
    if (e.ctrlKey) { if (S.selected.has(serial)) S.selected.delete(serial); else S.selected.add(serial); syncTiles(); return; }
    setFocus(serial);
  });
  const t = { el, canvas: el.querySelector('canvas'), player: null, det: new StereoDetector(), live: false, stopped: false };
  S.tiles.set(serial, t);
  return t;
}

function tileMsg(serial, msg) {
  const el = S.tiles.get(serial)?.el.querySelector('.msg');
  if (!el) return;
  el.textContent = msg || '';
  el.hidden = !msg;
}

function syncTiles() {
  for (const [serial, t] of S.tiles) {
    t.el.querySelector('.ot').innerHTML = topHtml(serial);
    t.el.classList.toggle('sel', S.selected.has(serial) && !S.focus);
    t.el.classList.toggle('recording', S.recording.has(serial));
    const rb = t.el.querySelector('.ib.rec');
    rb.classList.toggle('on', S.recording.has(serial));
    rb.querySelector('span').textContent = S.recording.has(serial) ? 'Stop rec' : 'Rec';
    rb.disabled = S.recBusy.has(serial);
  }
  layout();
  syncDock();
}

function layout() {
  const grid = $('lgrid');
  const n = S.order.length;
  $('lwEmpty').hidden = n > 0;
  $('lwInfo').textContent = `${plural(n, 'headset')} · ${S.settings.singleEye === false ? 'both eyes' : `${S.settings.castEye} eye`} · ${S.settings.castBitrate} Mbps`;
  if (S.focus && S.tiles.has(S.focus)) {
    grid.hidden = true;
    $('lfocus').classList.add('on');
    const t = S.tiles.get(S.focus);
    if (t.el.parentElement !== $('lfocus')) $('lfocus').appendChild(t.el);
    $('dockAll').hidden = true;
    $('dockOne').hidden = false;
    return;
  }
  $('lfocus').classList.remove('on');
  grid.hidden = !n;
  $('dockAll').hidden = false;
  $('dockOne').hidden = true;
  const lay = S.settings.castLayout || 'auto';
  const cols = lay === 'auto' ? (n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4) : +lay;
  grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows = `repeat(${Math.max(1, Math.ceil(n / cols))}, minmax(0, 1fr))`;
  // keep tiles in a stable order; re-attach only if the order is off (e.g. after enlarging one)
  const els = S.order.map((s) => S.tiles.get(s)?.el).filter(Boolean);
  const inPlace = els.length === grid.children.length && els.every((el, i) => grid.children[i] === el);
  if (!inPlace) els.forEach((el) => grid.appendChild(el));
}

function setFocus(serial) {
  S.focus = serial && S.tiles.has(serial) ? serial : null;
  if (!S.focus && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  syncTiles();
}

function syncDock() {
  const sel = [...S.selected].filter((s) => S.tiles.has(s)).length;
  $('lTgt').innerHTML = `Actions apply to <b>${sel ? `${sel} selected` : `all ${S.order.length} online`}</b> · Ctrl+click tiles to select`;
  const anyRec = S.order.some((s) => S.recording.has(s));
  $('dRecAll').classList.toggle('on', anyRec);
  $('dRecAll').querySelector('span').textContent = anyRec ? 'Stop all recordings' : 'Record all';
  if (S.focus) {
    const d = devBy(S.focus) || {};
    const c = d.controllers || {};
    $('oImg').src = modelImage(d);
    $('oName').textContent = `${label(S.focus)}${d.model && d.name ? ` · ${d.model}` : ''}`;
    $('oMeta').textContent = `${d.isWifi ? 'Wi-Fi' : 'USB'} · headset ${d.battery ?? '—'}% · controllers ${c.left ?? '—'}% / ${c.right ?? '—'}%`;
    const rec = S.recording.has(S.focus);
    $('oRec').classList.toggle('on', rec);
    $('oRec').querySelector('span').textContent = rec ? 'Stop recording' : 'Record';
    $('oRec').disabled = S.recBusy.has(S.focus);
    $('oStop').querySelector('span').textContent = S.tiles.get(S.focus)?.stopped ? 'Start stream' : 'Stop stream';
  }
}

/* ---------------- cast pipeline ---------------- */

function startCast(serials) {
  if (typeof VideoDecoder === 'undefined') { serials.forEach((s) => tileMsg(s, 'This computer cannot decode the live stream — showing snapshots')); return; }
  const start = [];
  for (const serial of serials) {
    const t = S.tiles.get(serial);
    if (!t || t.player) continue;
    t.stopped = false;
    t.live = false;
    tileMsg(serial, 'connecting…');
    t.player = new CastPlayer(serial, t.canvas, {
      crop: (w, h, stereo) => cropFor(w, stereo),
      tilt: () => tiltFor(devBy(serial), S.settings),
      view: () => viewOpts(),
      onLive: () => { t.live = true; tileMsg(serial, ''); syncTiles(); },
      onError: (msg) => castFailed(serial, msg),
    });
    start.push(serial);
  }
  if (start.length) window.vr.startCast({ serials: start });
}

function stopCast(serials, { paused = false } = {}) {
  const stop = serials.filter((s) => S.tiles.get(s)?.player);
  if (stop.length) window.vr.stopCast({ serials: stop });
  for (const s of serials) {
    const t = S.tiles.get(s);
    if (!t) continue;
    t.player?.destroy();
    t.player = null;
    t.live = false;
    t.stopped = paused;
  }
}

function castFailed(serial, msg) {
  stopCast([serial]);
  tileMsg(serial, '');
  const t = S.tiles.get(serial);
  if (t) t.snapshot = true;
  console.warn('[cast]', serial, msg);
  syncTiles();
}

window.vr.onCastData((serial, data) => {
  S.tiles.get(serial)?.player?.feed(data instanceof Uint8Array ? data : new Uint8Array(data));
});
window.vr.onCastEvent((serial, kind, msg) => {
  if (kind === 'restart') S.tiles.get(serial)?.player?.resync();
  else if (kind === 'error') castFailed(serial, msg);
});

/* Snapshot fallback for headsets whose live stream failed. */
setInterval(async () => {
  for (const [serial, t] of S.tiles) {
    if (!t.snapshot || t.player || t.stopped || S.thumbBusy.has(serial)) continue;
    S.thumbBusy.add(serial);
    try {
      const b64 = await window.vr.screenshot(serial);
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const stereo = t.det.sample(img, img.naturalWidth, img.naturalHeight);
      const { sx, sw } = cropFor(img.naturalWidth, stereo);
      drawEyeFrame(t.canvas, img, sx, sw, img.naturalHeight, tiltFor(devBy(serial), S.settings), viewOpts());
      if (!t.live) { t.live = true; syncTiles(); }
    } catch { /* screen off — keep the last frame */ }
    S.thumbBusy.delete(serial);
  }
}, 2000);

/* ---------------- screenshots & recording ---------------- */

function flash(serial) {
  const f = S.tiles.get(serial)?.el.querySelector('.flash');
  if (!f) return;
  f.classList.add('go');
  requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('go')));
}

async function screenshot(serial, quiet) {
  const t = S.tiles.get(serial);
  if (!t) return false;
  if (!t.live) { if (!quiet) toast(`${label(serial)} has no picture yet`, 'err'); return false; }
  flash(serial);
  try {
    const r = await window.vr.saveShot({ serial, dataUrl: t.canvas.toDataURL('image/png') });
    if (!quiet) toast(`Screenshot saved to Files · ${r.fileName}`);
    return true;
  } catch (err) {
    if (!quiet) toast(`Screenshot failed: ${err.message || err}`, 'err');
    return false;
  }
}

async function toggleRec(serial, quiet) {
  if (S.recBusy.has(serial)) return;
  S.recBusy.add(serial);
  syncTiles();
  try {
    if (S.recording.has(serial)) {
      if (!quiet) toast(`Saving ${label(serial)}'s recording…`, 'info');
      const r = await window.vr.stopRecording(serial);
      S.recording.delete(serial);
      if (!quiet) toast(`Recording saved to Files · ${mmss(r.durationMs / 1000)}`);
    } else {
      const r = await window.vr.startRecording(serial);
      S.recording.set(serial, r.startedAt || Date.now());
      if (!quiet) toast(`Recording ${label(serial)}…`, 'info');
    }
  } catch (err) {
    toast(`Recording ${label(serial)}: ${err.message || err}`, 'err');
  } finally {
    S.recBusy.delete(serial);
    syncTiles();
  }
}

// keep REC timers ticking
setInterval(() => {
  document.querySelectorAll('[data-rt]').forEach((el) => {
    const at = S.recording.get(el.dataset.rt);
    if (at) el.innerHTML = `${ic('rec')}REC ${mmss((Date.now() - at) / 1000)}`;
  });
}, 1000);

/* ---------------- dock actions ---------------- */

async function sendKey(serials, code, what) {
  if (!serials.length) return;
  toastResults(what, await window.vr.sendKey({ serials, code }), label);
}
$('dHome').addEventListener('click', () => sendKey(targets(), 3, 'Home'));
$('dWake').addEventListener('click', () => sendKey(targets(), 224, 'Wake'));
$('oHome').addEventListener('click', () => sendKey(targets(), 3, 'Home'));
$('oWake').addEventListener('click', () => sendKey(targets(), 224, 'Wake'));
const volOpts = { targets, label: targetLabel, onApply: (r, v) => toastResults(v === 0 ? 'Muted' : `Volume ${v}%`, r, label) };
$('dVol').addEventListener('click', () => Volume.open($('dVol'), volOpts));
$('oVol').addEventListener('click', () => Volume.open($('oVol'), volOpts));
$('dApps').addEventListener('click', () => openPanel('apps'));
$('oApps').addEventListener('click', () => openPanel('apps'));
$('dVids').addEventListener('click', () => openPanel('videos'));
$('oVids').addEventListener('click', () => openPanel('videos'));
$('dShotAll').addEventListener('click', async () => {
  const list = targets();
  let n = 0;
  for (const s of list) if (await screenshot(s, true)) n++;
  toast(n ? `${plural(n, 'screenshot')} saved to Files` : 'No headset has a picture yet', n ? 'ok' : 'err');
});
$('dRecAll').addEventListener('click', async () => {
  const list = targets();
  const stopping = list.some((s) => S.recording.has(s));
  const todo = list.filter((s) => S.recording.has(s) === stopping);
  if (!todo.length) return;
  toast(stopping ? `Saving ${plural(todo.length, 'recording')}…` : `Recording ${plural(todo.length, 'headset')}…`, 'info');
  await Promise.all(todo.map((s) => toggleRec(s, true)));
  if (stopping) toast(`${plural(todo.length, 'recording')} saved to Files`);
});
$('dEnd').addEventListener('click', () => window.close());
$('oBack').addEventListener('click', () => setFocus(null));
$('oShot').addEventListener('click', () => S.focus && screenshot(S.focus));
$('oRec').addEventListener('click', () => S.focus && toggleRec(S.focus));
$('oFull').addEventListener('click', () => {
  const el = S.tiles.get(S.focus)?.el;
  if (!el) return;
  if (document.fullscreenElement) document.exitFullscreen(); else el.requestFullscreen().catch(() => {});
});
$('oStop').addEventListener('click', () => {
  const s = S.focus;
  const t = S.tiles.get(s);
  if (!t) return;
  if (t.stopped || (!t.player && !t.snapshot)) { t.snapshot = false; startCast([s]); }
  else { t.snapshot = false; stopCast([s], { paused: true }); tileMsg(s, 'Stream paused — press Start stream to resume'); }
  syncTiles();
});

/* ---------------- view controls (persisted, shared with Settings) ---------------- */

function renderControls() {
  const s = S.settings;
  setSeg($('lEye'), s.singleEye === false ? 'both' : s.castEye);
  setSeg($('lFit'), s.castFit);
  setSeg($('lLay'), s.castLayout || 'auto');
  setSeg($('lQual'), String(s.castBitrate));
  const trim = Math.round((s.castTrim || 0) * 100);
  if (document.activeElement !== $('lTrim')) $('lTrim').value = trim;
  $('lTrimV').textContent = `${trim}%`;
}
async function save(patch) {
  const prevRate = S.settings.castBitrate;
  S.settings = await window.vr.setSettings(patch);
  renderControls();
  layout();
  if (S.settings.castBitrate !== prevRate) restartAll();
}
function restartAll() {
  const live = S.order.filter((s) => S.tiles.get(s)?.player);
  stopCast(live);
  setTimeout(() => startCast(live), 400);
  toast(`Stream quality set to ${S.settings.castBitrate} Mbps per headset`, 'info');
}
wireSeg($('lEye'), (v) => save(v === 'both' ? { singleEye: false } : { singleEye: true, castEye: v }));
wireSeg($('lFit'), (v) => save({ castFit: v }));
wireSeg($('lLay'), (v) => save({ castLayout: v }));
wireSeg($('lQual'), (v) => save({ castBitrate: +v }));
$('lTrim').addEventListener('input', (e) => { S.settings.castTrim = e.target.value / 100; $('lTrimV').textContent = `${e.target.value}%`; });
$('lTrim').addEventListener('change', (e) => save({ castTrim: e.target.value / 100 }));
window.vr.onSettingsChanged((s) => {
  const prevRate = S.settings.castBitrate;
  S.settings = s;
  renderControls();
  layout();
  if (prevRate && s.castBitrate !== prevRate) restartAll();
});

/* ---------------- launch app / 360° video panel ---------------- */

const P = { mode: 'apps', q: '', sel: null, lists: new Map(), loading: false, targets: [], xfer: null };

async function openPanel(mode) {
  P.mode = mode;
  P.sel = null;
  P.q = '';
  P.targets = targets();
  $('lpSearch').value = '';
  $('lp').classList.add('on');
  await loadPanel();
  $('lpSearch').focus();
}
async function loadPanel() {
  P.loading = true;
  renderPanel();
  const fn = P.mode === 'apps' ? window.vr.listApps : window.vr.listDeviceVideos;
  const res = await Promise.all(P.targets.map((s) => fn(s).catch(() => [])));
  P.lists = new Map(P.targets.map((s, i) => [s, new Set(res[i])]));
  P.loading = false;
  renderPanel();
}
const closePanel = () => $('lp').classList.remove('on');

function renderPanel() {
  const T = P.targets;
  const N = T.length;
  const one = N === 1;
  const isA = P.mode === 'apps';
  $('lpTitle').textContent = isA ? 'Launch app' : 'Play 360° video';
  $('lpIco').className = `lpico${isA ? '' : ' v'}`;
  $('lpIco').innerHTML = ic(isA ? 'rocket' : 'film');
  $('lpTgt').innerHTML = one ? `On <b>${esc(label(T[0]))}</b>` : `On <b>${N} headsets</b> · ${T.map((s) => esc(label(s))).join(', ')}`;
  $('lpSearch').placeholder = isA ? 'Search apps on the headset…' : 'Search videos on the headset…';
  const body = $('lpBody');
  const counts = new Map();
  for (const set of P.lists.values()) for (const id of set) counts.set(id, (counts.get(id) || 0) + 1);
  const q = P.q.toLowerCase();
  const items = [...counts.entries()]
    .map(([id, c]) => ({ id, c, name: isA ? prettyApp(id) : id }))
    .filter((x) => !q || `${x.name} ${x.id}`.toLowerCase().includes(q))
    .sort((a, b) => b.c - a.c || a.name.localeCompare(b.name));

  if (P.loading) body.innerHTML = '<div class="loading">Reading the headsets…</div>';
  else if (isA) {
    body.innerHTML = `<div class="lblx">${items.length} APP${items.length === 1 ? '' : 'S'} INSTALLED${one ? ' ON THIS HEADSET' : ''}</div>
      <div class="lpapps">${items.map((x) => `<button class="ap ${P.sel === x.id ? 'on' : ''}" data-id="${esc(x.id)}">
        <span class="appico ${hueClass(x.id)}">${esc(x.name[0] || '?')}</span><b>${esc(x.name)}</b><small>${esc(x.id)}</small>
        ${one ? '' : `<div class="cnt ${x.c === N ? 'ok' : 'part'}">${x.c === N ? `on all ${N}` : `on ${x.c} of ${N}`}</div>`}</button>`).join('')}</div>
      ${items.length ? '' : '<div class="loading">No apps found — install an APK below.</div>'}`;
  } else {
    body.innerHTML = `<div class="updrop"><div class="big">${ic('upload')}</div><div class="tx"><b>Upload a video to ${one ? esc(label(T[0])) : `${N} headsets`}</b><div class="muted">MP4 · MKV · WEBM · MOV</div></div><button class="btn p s" id="lpUp">${ic('upload')}Browse…</button></div>
      ${P.xfer ? xferHtml() : ''}
      <div class="lblx">${items.length} VIDEO${items.length === 1 ? '' : 'S'} ON ${one ? 'THIS HEADSET' : 'THE HEADSETS'}</div>
      ${items.map((x) => `<div class="vrow2 ${P.sel === x.id ? 'on' : ''}" data-id="${esc(x.id)}"><div class="vth ${hueClass(x.id)}">${ic('film')}</div>
        <div class="tx"><b>${esc(x.name)}</b><small>360° video</small></div>
        <div class="av ${x.c === N ? 'st ok' : 'st miss'}">${x.c === N ? (one ? 'On headset' : `On all ${N}`) : `On ${x.c} of ${N}`}</div></div>`).join('')}
      ${items.length ? '' : '<div class="loading">No videos yet — upload one above.</div>'}`;
    $('lpUp').addEventListener('click', () => upload(T));
    body.querySelectorAll('.prog i[data-w]').forEach((i) => { i.style.width = `${i.dataset.w}%`; });
  }

  const sel = P.sel;
  const have = sel ? T.filter((s) => P.lists.get(s)?.has(sel)) : [];
  const nm = sel ? (isA ? prettyApp(sel) : sel) : '';
  $('lpFoot').innerHTML = isA
    ? `<button class="btn s" id="lpApk">${ic('package')}Install APK…</button><span class="sp"></span>
       ${sel && have.length < N ? `<span class="muted">${N - have.length} headset(s) don't have it</span>` : ''}
       <button class="btn s d" id="lpStop" ${sel ? '' : 'disabled'}>${ic('stop')}Force stop</button>
       <button class="btn g" id="lpGo" ${sel && have.length ? '' : 'disabled'}>${ic('play')}${sel ? `Launch ${esc(nm)}${!one ? ` on ${have.length}` : ''}` : 'Select an app'}</button>`
    : `<button class="btn s" id="lpPause">${ic('playpause')}Pause / resume</button><button class="btn s d" id="lpStopV">${ic('stop')}Stop &amp; home</button><span class="sp"></span>
       <button class="btn p" id="lpGo" ${sel && have.length ? '' : 'disabled'}>${ic('play')}${sel ? (have.length ? `Play${one ? '' : ` in sync on ${have.length}`}` : 'Upload it first') : 'Select a video'}</button>`;
  $('lpApk')?.addEventListener('click', async () => {
    const r = await window.vr.installApk({ serials: T });
    if (!r.canceled) { toastResults(`Installed ${r.apk}`, r.results, label); loadPanel(); }
  });
  $('lpStop')?.addEventListener('click', async () => toastResults(`Stopped ${nm}`, await window.vr.stopApp({ serials: T, pkg: sel }), label));
  $('lpPause')?.addEventListener('click', async () => toastResults('Pause / resume', await window.vr.pauseVideo({ serials: T }), label));
  $('lpStopV')?.addEventListener('click', async () => toastResults('Stopped video', await window.vr.stopVideo({ serials: T }), label));
  $('lpGo')?.addEventListener('click', async () => {
    const r = isA ? await window.vr.launchApp({ serials: have, pkg: sel }) : await window.vr.playVideo({ serials: have, fileName: sel });
    toastResults(`${isA ? 'Launched' : 'Playing'} ${nm}`, r, label);
    if (r.every((x) => x.ok)) closePanel();
  });
}

function xferHtml() {
  const x = P.xfer;
  return `<div class="xfer"><div class="hd2"><b class="sp">Uploading ${esc(x.name)}</b><span class="muted">${x.size ? prettyBytes(x.size) : ''}</span></div>${[...x.rows.entries()].map(([s, r]) => {
    const st = r.phase === 'done' ? `<span class="st ok">${ic('check')}</span>` : r.phase === 'failed' ? `<span class="st bad">${ic('x')}</span>` : `<span class="st run">${r.pct}%</span>`;
    return `<div class="drow"><img class="thumb30" src="${modelImage(devBy(s))}" alt="" /><span class="nm">${esc(label(s))}</span><span class="prog ${r.phase === 'done' ? 'done' : ''}"><i data-w="${r.pct}"></i></span>${st}</div>`;
  }).join('')}</div>`;
}
window.vr.onTransferProgress(({ name, size, serial, phase, pct }) => {
  if (!P.xfer || P.xfer.name !== name) P.xfer = { name, size, rows: new Map() };
  P.xfer.rows.set(serial, { phase, pct });
  if ($('lp').classList.contains('on') && P.mode === 'videos') renderPanel();
});
async function upload(serials) {
  const r = await window.vr.pushVideo({ serials });
  if (r.canceled) return;
  toastResults(`Uploaded ${r.fileName}`, r.results, label);
  P.sel = r.fileName;
  setTimeout(() => { P.xfer = null; }, 4000);
  loadPanel();
}
$('lpBody').addEventListener('click', (e) => {
  const it = e.target.closest('[data-id]');
  if (it) { P.sel = it.dataset.id; renderPanel(); }
});
$('lpSearch').addEventListener('input', (e) => { P.q = e.target.value; renderPanel(); });
$('lpRefresh').addEventListener('click', loadPanel);
$('lpClose').addEventListener('click', closePanel);
$('lp').addEventListener('click', (e) => { if (e.target === $('lp')) closePanel(); });

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('lp').classList.contains('on')) closePanel();
  else if (S.focus && !document.fullscreenElement) setFocus(null);
});

/* ---------------- device polling: tiles follow who's online ---------------- */

async function poll() {
  try { S.devices = await window.vr.listDevices(); } catch { return; }
  try {
    const rec = await window.vr.recordingStatus();
    S.recording = new Map(rec.map((r) => [r.serial, r.startedAt]));
  } catch { /* keep */ }
  const online = shownSerials();
  const added = online.filter((s) => !S.tiles.has(s));
  const gone = [...S.tiles.keys()].filter((s) => !online.includes(s));
  if (gone.length) {
    stopCast(gone);
    for (const s of gone) { S.tiles.get(s).el.remove(); S.tiles.delete(s); S.selected.delete(s); }
    if (S.focus && gone.includes(S.focus)) S.focus = null;
  }
  for (const s of added) buildTile(s);
  S.order = online;
  syncTiles();
  if (added.length) startCast(added);
}

window.vr.onWallFocus((serial) => { if (serial) setFocus(serial); });
window.addEventListener('beforeunload', () => stopCast([...S.tiles.keys()]));

(async function boot() {
  S.settings = await window.vr.getSettings();
  renderControls();
  await poll();
  const focus = new URLSearchParams(location.search).get('focus');
  if (focus) setFocus(focus);
  setInterval(poll, 3000);
})();
