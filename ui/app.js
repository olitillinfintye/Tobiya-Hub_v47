/* Tobiya Hub 0.4.7 — main window renderer. Talks to the main process via window.vr.
   Shared helpers ($, esc, toast, Volume, modelImage, …) live in common.js; the
   icon sprite in icons.js; the H.264/eye painter in cast-player.js. */

const state = {
  settings: {},
  devices: [],
  selected: new Set(),        // serials ticked on the Devices page
  cards: new Map(),           // serial -> card element (built once, updated in place)
  recording: new Map(),       // serial -> startedAt
  license: null,
  filter: 'all',
  query: '',
  view: 'cards',
  page: 'devices',
  ctlSerial: null,
  files: [],
  wallOpen: false,
};

const PAGES = {
  devices: 'Devices',
  order: 'Order Checker',
  content: 'Content library',
  files: 'Files',
  insights: 'Insights',
  settings: 'Settings',
};

/* ---------------- headset helpers ---------------- */

const devBy = (serial) => state.devices.find((d) => d.serial === serial);
const label = (serial) => { const d = devBy(serial); return d?.name || d?.model || serial; };
const isOnline = (d) => d?.state === 'device';
const isControllable = (d) => isOnline(d) && d.withinLicense !== false;
const onlineList = () => state.devices.filter(isOnline);
const controllable = () => state.devices.filter(isControllable).map((d) => d.serial);

/** Commands act on the selected headsets; with none selected, on every controllable one.
    A selection of only offline headsets targets nothing — never silently everyone. */
function targetSerials() {
  const ok = controllable();
  if (state.selected.size) return ok.filter((s) => state.selected.has(s));
  return ok;
}
function targetLabel() {
  const t = targetSerials();
  if (t.length === 1) return label(t[0]);
  return state.selected.size ? `${t.length} selected` : `All ${t.length} online`;
}
function requireTargets() {
  const t = targetSerials();
  if (!t.length) toast(state.selected.size ? 'None of the selected headsets are online.' : 'No online headsets to command.', 'err');
  return t;
}

/* ---------------- navigation ---------------- */

function go(page) {
  state.page = page;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.page === page));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('on', p.id === `page-${page}`));
  $('ttl').textContent = PAGES[page];
  renderSub();
  if (page !== 'devices') $('selbar').classList.remove('on'); else updateSelection();
  if (page === 'order') renderLicense();
  if (page === 'content') loadContent();
  if (page === 'files') loadFiles();
  if (page === 'insights') loadInsights();
  if (page === 'settings') { renderSettings(); refreshPreview(); }
}
$('nav').addEventListener('click', (e) => { const b = e.target.closest('button[data-page]'); if (b) go(b.dataset.page); });
$('hLic').addEventListener('click', () => go('order'));

function renderSub() {
  const on = onlineList().length;
  const all = state.devices.length;
  const sub = {
    devices: all ? `${plural(all, 'headset')} · ${on} online${state.devices.some((d) => d.state === 'unauthorized') ? ' · some need authorizing' : ''}` : 'No headsets detected yet',
    order: 'Activate your license and track how many headsets you’re cleared to manage',
    content: 'Apps and 360° videos on your headsets',
    files: 'Recordings and screenshots captured in Live cast',
    insights: 'Usage, sessions and content analytics',
    settings: 'Live cast, recordings and connection',
  }[state.page];
  $('sub').textContent = sub;
}

/* ---------------- devices: polling ---------------- */

async function pollDevices() {
  let devices;
  try { devices = await window.vr.listDevices(); } catch { return; }
  state.devices = devices;
  try {
    const rec = await window.vr.recordingStatus();
    state.recording = new Map(rec.map((r) => [r.serial, r.startedAt]));
  } catch { /* keep last known */ }

  // drop selections of headsets that vanished from the registry
  for (const s of [...state.selected]) if (!devBy(s)) state.selected.delete(s);
  renderDevices();
  updateSelection();
  renderSide();
  renderSub();
  if (state.page === 'order') renderLicense();
}

/** Explain why no headset shows up and offer a one-click fix. */
async function renderAdbHelp() {
  const grid = $('devGrid');
  let box = $('adbHelp');
  if (!box) {
    box = document.createElement('div');
    box.id = 'adbHelp';
    box.className = 'empty';
    box.style.order = -1;
    box.style.gridColumn = '1 / -1';
    grid.appendChild(box);
  }
  let st = null;
  try { st = await window.vr.adbStatus(); } catch { /* ignore */ }
  const anyOnline = onlineList().length > 0;
  const waiting = state.devices.some((d) => d.state === 'unauthorized');
  let msg = '';
  if (st && !st.ok) msg = st.error || 'ADB is not responding.';
  else if (!anyOnline && st && st.usb && st.usb.length) msg = 'A headset is plugged in but ADB can’t see it yet. Put the headset on and accept “Allow USB debugging” (tick Always allow).';
  else if (waiting) msg = 'Accept “Allow USB debugging” in the headset. If it was already accepted, press Fix detection.';
  box.hidden = !msg;
  if (msg) {
    box.innerHTML = `<div class="big">${ic('lock')}</div><b>Headset not detected</b>${esc(msg)} <button class="lnk" id="adbFix">${st && st.fixing ? 'Fixing…' : 'Fix detection'}</button>`;
    $('adbFix').addEventListener('click', async () => {
      $('adbFix').textContent = 'Fixing…';
      try { await window.vr.fixAdb(); } catch { /* shown on next poll */ }
      pollDevices();
    });
  }
}

function renderSide() {
  const on = onlineList().length;
  $('nbDevices').textContent = `${on}/${state.devices.length}`;
  $('hOnline').textContent = on;
  $('hAdb').textContent = state.devices.length || on ? 'connected' : 'running';
  $('hAdb').className = 'ok';
  const lic = state.license;
  const lt = $('hLicT');
  if (!lic) { lt.textContent = 'not activated'; lt.className = 'bad'; return; }
  const left = timeLeft(lic.expiresAt);
  const ok = lic.valid !== false && lic.status !== 'revoked' && !lic.boundElsewhere && left.active;
  lt.textContent = ok ? left.short : lic.boundElsewhere ? 'locked elsewhere' : lic.status === 'revoked' ? 'revoked' : 'expired';
  lt.className = ok ? (left.soon ? '' : 'ok') : 'bad';
}

/* ---------------- devices: cards ---------------- */

function lowBattery(d) {
  if (!isOnline(d)) return false;
  return [d.battery, d.controllers?.left, d.controllers?.right].some((v) => v != null && v < 20);
}
function matches(d) {
  if (state.filter === 'online' && !isOnline(d)) return false;
  if (state.filter === 'offline' && isOnline(d)) return false;
  if (state.filter === 'low' && !lowBattery(d)) return false;
  if (state.query) {
    const hay = `${d.name || ''} ${d.model || ''} ${d.product || ''} ${d.serial} ${d.lastIp || ''}`.toLowerCase();
    if (!hay.includes(state.query)) return false;
  }
  return true;
}
const RANK = { device: 0, unauthorized: 1, offline: 2 };

function renderDevices() {
  const ds = state.devices;
  const on = ds.filter(isOnline);
  const batts = on.map((d) => d.battery).filter((b) => b != null);
  $('kOnline').textContent = `${on.length} / ${ds.length}`;
  $('kBatt').textContent = batts.length ? `${Math.round(batts.reduce((a, b) => a + b, 0) / batts.length)}%` : '—';
  $('kLow').textContent = ds.filter(lowBattery).length;
  const cap = activeSeats();
  $('kSeats').textContent = state.license ? `${Math.min(on.length, cap)} / ${cap}` : 'no license';
  $('cAll').textContent = ds.length;
  $('cOnline').textContent = on.length;
  $('cOffline').textContent = ds.length - on.length;
  $('cLow').textContent = ds.filter(lowBattery).length;

  const grid = $('devGrid');
  const seen = new Set();
  const ordered = [...ds].sort((a, b) => (RANK[a.state] ?? 3) - (RANK[b.state] ?? 3) || label(a.serial).localeCompare(label(b.serial)));
  let shown = 0;
  ordered.forEach((d, i) => {
    seen.add(d.serial);
    let card = state.cards.get(d.serial);
    if (!card) {
      card = buildCard(d.serial);
      state.cards.set(d.serial, card);
      grid.appendChild(card);
    }
    if (!card.classList.contains('renaming')) updateCard(card, d);
    const vis = matches(d);
    card.hidden = !vis;
    card.style.order = i;
    if (vis) shown++;
  });
  for (const [serial, card] of state.cards) {
    if (!seen.has(serial)) { card.remove(); state.cards.delete(serial); }
  }

  let add = $('addCard');
  if (!add) {
    add = document.createElement('button');
    add.id = 'addCard';
    add.className = 'addcard';
    add.innerHTML = `<div><div class="plus">${ic('plus')}</div><b>Add a headset</b><span>Plug in via USB or connect by IP</span></div>`;
    add.addEventListener('click', openAdd);
    grid.appendChild(add);
  }
  add.style.order = 9999;
  add.hidden = state.filter !== 'all' || !!state.query;

  let empty = $('devEmpty');
  if (!empty) {
    empty = document.createElement('div');
    empty.id = 'devEmpty';
    empty.className = 'empty';
    grid.appendChild(empty);
  }
  empty.style.order = 9998;
  empty.hidden = shown > 0 || !ds.length;
  if (!empty.hidden) {
    const why = state.query ? `Nothing matches “${state.query}”.`
      : state.filter === 'low' ? 'Every battery is above 20%.'
        : state.filter === 'offline' ? 'Every headset is online.' : 'No headsets are online right now.';
    empty.innerHTML = `<div class="big">${ic('search')}</div><b>No headsets match</b>${esc(why)} <button class="lnk" id="devReset">Show all</button>`;
    $('devReset').addEventListener('click', resetDeviceFilter);
  }
  grid.classList.toggle('selecting', state.selected.size > 0);
  renderDeviceList();
}

function resetDeviceFilter() {
  state.filter = 'all';
  state.query = '';
  $('devSearch').value = '';
  $('devFilters').querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c.dataset.f === 'all'));
  renderDevices();
}

function buildCard(serial) {
  const card = document.createElement('div');
  card.className = 'dc';
  card.dataset.serial = serial;
  card.innerHTML = `
    <div class="hero">
      <img alt="" draggable="false" />
      <span class="stt"><i></i><span class="stt-t"></span></span>
      <span class="stt rec" hidden>${ic('rec')} REC</span>
      <button class="ck" title="Select">${ic('check')}</button>
      <div class="nameb"><div class="nm"><b class="name" title="Double-click to rename"></b><span class="model"></span></div>
        <button class="ed">${ic('pencil')}Rename</button></div>
    </div>
    <div class="stats">
      <div><small>${ic('headset')}Headset</small><b class="b-h"></b></div>
      <div><small>${ic('gamepad')}Left</small><b class="b-l"></b></div>
      <div><small>${ic('gamepad')}Right</small><b class="b-r"></b></div>
    </div>
    <div class="now"></div>
    <div class="warns"></div>
    <div class="act"></div>`;

  card.querySelector('.ck').addEventListener('click', () => toggleSelect(serial));
  card.querySelector('.ed').addEventListener('click', () => startRename(card, serial));
  card.querySelector('.name').addEventListener('dblclick', () => startRename(card, serial));
  card.querySelector('.act').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    if (a === 'ctl') openCtl(serial);
    else if (a === 'live') window.vr.openWall({ focus: serial });
    else if (a === 'reconnect') reconnect(serial);
  });
  return card;
}

function battCell(el, pct, online, notConnected = 'Not connected') {
  if (pct == null) {
    el.className = `${el.className.split(' ')[0]} na`;
    el.textContent = online ? notConnected : '—';
    return;
  }
  el.className = `${el.className.split(' ')[0]} ${levelClass(pct)}`;
  el.innerHTML = `<span class="ring"></span>${pct}%`;
  paintRing(el.querySelector('.ring'), pct);
}

function updateCard(card, d) {
  const online = isOnline(d);
  const locked = online && d.withinLicense === false;
  const auth = d.state === 'unauthorized';
  card.className = `dc${online ? '' : ' off'}${locked ? ' locked' : ''}${auth ? ' auth' : ''}${state.selected.has(d.serial) ? ' sel' : ''}`;
  const img = card.querySelector('.hero img');
  const src = modelImage(d);
  if (img.getAttribute('src') !== src) img.src = src;
  card.querySelector('.name').textContent = d.name || d.model || d.serial;
  card.querySelector('.model').textContent = d.name ? (d.model || 'Android headset') : d.serial;
  const link = d.isWifi ? 'Wi-Fi' : 'USB';
  card.querySelector('.stt-t').textContent = locked ? 'Not licensed'
    : online ? `Online · ${link}`
      : auth ? 'Authorize in headset'
        : `Offline${d.lastSeen ? ` · seen ${new Date(d.lastSeen).toLocaleDateString()}` : ''}`;
  card.querySelector('.stt.rec').hidden = !state.recording.has(d.serial);
  card.querySelector('.ck').innerHTML = ic('check');

  battCell(card.querySelector('.b-h'), d.battery, online, '—');
  battCell(card.querySelector('.b-l'), d.controllers?.left, online);
  battCell(card.querySelector('.b-r'), d.controllers?.right, online);

  const now = card.querySelector('.now');
  if (online) {
    const r = nowRunning(d.foreground);
    const icon = r.kind === 'home' ? ic('home') : r.kind === 'video' ? ic('film') : esc(r.label[0] || '?');
    const key = `${r.kind}|${r.label}`;
    if (now.dataset.key !== key) {
      now.dataset.key = key;
      now.innerHTML = `<span class="appico ${r.kind === 'app' ? hueClass(r.pkg) : ''}">${icon}</span>
        <div class="tx"><small>Now running</small><b title="${esc(d.foreground || '')}">${esc(r.label)}</b></div>`;
    }
  } else {
    now.dataset.key = '';
    now.innerHTML = auth
      ? `<span class="appico">${ic('lock')}</span><div class="tx"><small>Waiting</small><b>Accept “Allow USB debugging” in the headset</b></div>`
      : `<span class="appico">${ic('refresh')}</span><div class="tx"><small>Connection lost</small><b class="muted">${d.lastIp ? `Last at ${esc(d.lastIp)}` : 'Plug it in or connect by IP'}</b></div>`;
  }

  const warns = [];
  if (locked) warns.push(`<div class="warn am">${ic('lock')}Outside your licensed capacity — renew or order more seats</div>`);
  if (online && d.battery != null && d.battery < 20) warns.push(`<div class="warn">${ic('alert')}Headset battery low — charge after this session</div>`);
  if (online && [d.controllers?.left, d.controllers?.right].some((v) => v != null && v < 20)) warns.push(`<div class="warn">${ic('alert')}Controller battery low — swap batteries soon</div>`);
  const wEl = card.querySelector('.warns');
  const wHtml = warns.join('');
  if (wEl.dataset.h !== wHtml) { wEl.dataset.h = wHtml; wEl.innerHTML = wHtml; }

  const act = card.querySelector('.act');
  const aKey = online ? (locked ? 'locked' : 'on') : d.lastIp ? 'recon' : 'off';
  if (act.dataset.k !== aKey) {
    act.dataset.k = aKey;
    act.innerHTML = aKey === 'on'
      ? `<button class="btn s" data-a="ctl">${ic('gamepad')}Control</button><button class="btn s lc" data-a="live"><span class="pulse red"></span>Live cast</button>`
      : aKey === 'locked'
        ? `<button class="btn s span" data-a="none" disabled>${ic('lock')}Not licensed</button>`
        : aKey === 'recon'
          ? `<button class="btn s span" data-a="reconnect">${ic('refresh')}Reconnect</button>`
          : `<button class="btn s span" disabled>${ic('plug')}Plug in to connect</button>`;
  }
}

function renderDeviceList() {
  const rows = [...state.devices].filter(matches);
  const cell = (v) => (v == null ? '<span class="muted">—</span>' : `<b class="${levelClass(v)}">${v}%</b>`);
  $('devRows').innerHTML = rows.map((d) => `
    <tr data-serial="${esc(d.serial)}">
      <td><input type="checkbox" class="rowck" ${state.selected.has(d.serial) ? 'checked' : ''} /></td>
      <td><div class="cellrow"><img class="thumb30" src="${modelImage(d)}" alt="" /><b>${esc(d.name || d.model || d.serial)}</b></div></td>
      <td class="muted">${esc(d.model || '—')}</td>
      <td><span class="pill ${isOnline(d) ? 'g' : d.state === 'unauthorized' ? 'a' : 'r'}">${isOnline(d) ? 'Online' : d.state === 'unauthorized' ? 'Authorize' : 'Offline'}</span></td>
      <td>${cell(d.battery)}</td>
      <td>${cell(d.controllers?.left)} / ${cell(d.controllers?.right)}</td>
      <td class="muted">${isOnline(d) ? (d.isWifi ? 'Wi-Fi' : 'USB') : '—'}</td>
      <td>${isOnline(d) ? esc(nowRunning(d.foreground).label) : '—'}</td>
      <td>${isControllable(d) ? '<button class="btn s rowctl">Control</button>' : ''}</td>
    </tr>`).join('') || '<tr><td colspan="9" class="muted">No headsets match.</td></tr>';
}
$('devRows').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-serial]');
  if (!tr) return;
  if (e.target.closest('.rowck')) toggleSelect(tr.dataset.serial);
  else if (e.target.closest('.rowctl')) openCtl(tr.dataset.serial);
});

$('devFilters').addEventListener('click', (e) => {
  const c = e.target.closest('.chip');
  if (!c) return;
  state.filter = c.dataset.f;
  $('devFilters').querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === c));
  renderDevices();
});
$('devSearch').addEventListener('input', (e) => { state.query = e.target.value.trim().toLowerCase(); renderDevices(); });
wireSeg($('devView'), (v) => {
  state.view = v;
  $('devGrid').hidden = v !== 'cards';
  $('devList').hidden = v !== 'list';
});

async function reconnect(serial) {
  const d = devBy(serial);
  if (!d?.lastIp) return;
  toast(`Reconnecting to ${label(serial)} at ${d.lastIp}…`, 'info');
  try {
    await window.vr.connectIp(d.lastIp);
    toast(`${label(serial)} reconnected`);
    pollDevices();
  } catch (err) {
    toast(`Reconnect failed: ${err.message || err}`, 'err');
  }
}

/* ---------------- inline rename ---------------- */

function startRename(card, serial) {
  if (card.classList.contains('renaming')) return;
  const d = devBy(serial);
  card.classList.add('renaming');
  const box = card.querySelector('.nameb .nm');
  const ed = card.querySelector('.ed');
  box.innerHTML = `<input class="nmin" maxlength="30" /><span>${esc(d?.model || serial)}</span>`;
  ed.innerHTML = `${ic('check')}Save`;
  const inp = box.querySelector('input');
  inp.value = d?.name || '';
  inp.placeholder = d?.model || 'Headset name';
  inp.focus();
  inp.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const name = inp.value.trim().replace(/\s+/g, ' ');
    if (save && name !== (d?.name || '')) {
      try {
        await window.vr.renameDevice({ serial, name });
        toast(name ? `Renamed to “${name}”` : 'Name cleared');
      } catch (err) {
        toast(`Could not rename: ${err.message || err}`, 'err');
      }
    }
    // restore the card's normal markup, then refresh it from fresh data
    box.innerHTML = '<b class="name" title="Double-click to rename"></b><span class="model"></span>';
    box.querySelector('.name').addEventListener('dblclick', () => startRename(card, serial));
    ed.innerHTML = `${ic('pencil')}Rename`;
    card.classList.remove('renaming');
    await pollDevices();
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
  });
  inp.addEventListener('blur', () => finish(true));
  ed.addEventListener('mousedown', (e) => { if (card.classList.contains('renaming')) { e.preventDefault(); finish(true); } }, { once: true });
}

/* ---------------- selection ---------------- */

function toggleSelect(serial) {
  if (state.selected.has(serial)) state.selected.delete(serial);
  else state.selected.add(serial);
  const card = state.cards.get(serial);
  if (card) card.classList.toggle('sel', state.selected.has(serial));
  $('devGrid').classList.toggle('selecting', state.selected.size > 0);
  updateSelection();
  renderDeviceList();
}

function updateSelection() {
  const n = state.selected.size;
  $('selN').textContent = `${n} selected`;
  $('selbar').classList.toggle('on', n > 0 && state.page === 'devices');
  const t = targetSerials();
  $('tgtTxt').textContent = n ? `${n} selected` : 'All online';
  $('tgtN').textContent = n ? `(${t.length} online)` : `(${t.length})`;
  $('targetChip').classList.toggle('sel', n > 0);
  $('targetChip').title = n ? 'Click to clear the selection and target every online headset' : 'Commands target every online headset — tick cards to target a few';
}
$('targetChip').addEventListener('click', () => { if (state.selected.size) clearSelection(); });
function clearSelection() {
  state.selected.clear();
  for (const c of state.cards.values()) c.classList.remove('sel');
  $('devGrid').classList.remove('selecting');
  updateSelection();
  renderDeviceList();
}
$('sbClear').addEventListener('click', clearSelection);

/* ---------------- batch commands (top bar + selection bar) ---------------- */

async function sendKey(code, what) {
  const t = requireTargets();
  if (!t.length) return;
  const r = await window.vr.sendKey({ serials: t, code });
  toastResults(what, r, label);
}
const KEY_HOME = 3; const KEY_WAKE = 224; const KEY_SLEEP = 223;
$('qaHome').addEventListener('click', () => sendKey(KEY_HOME, 'Home'));
$('qaWake').addEventListener('click', () => sendKey(KEY_WAKE, 'Wake'));
$('qaSleep').addEventListener('click', () => sendKey(KEY_SLEEP, 'Sleep'));
$('sbHome').addEventListener('click', () => sendKey(KEY_HOME, 'Home'));
$('sbWake').addEventListener('click', () => sendKey(KEY_WAKE, 'Wake'));
$('sbSleep').addEventListener('click', () => sendKey(KEY_SLEEP, 'Sleep'));
const volOpts = { targets: targetSerials, label: targetLabel, onApply: (r, v) => toastResults(v === 0 ? 'Muted' : `Volume ${v}%`, r, label) };
$('qaVol').addEventListener('click', () => Volume.open($('qaVol'), volOpts));
$('sbVol').addEventListener('click', () => Volume.open($('sbVol'), volOpts));
$('sbLaunch').addEventListener('click', () => go('content'));
$('sbLive').addEventListener('click', () => openLive());

$('sbReboot').addEventListener('click', async () => {
  const t = requireTargets();
  if (!t.length) return;
  if (!(await confirmBox({ title: `Reboot ${plural(t.length, 'headset')}?`, text: 'They restart and reconnect automatically.', list: t, ok: 'Reboot', icon: 'refresh' }))) return;
  toastResults('Reboot sent', await window.vr.reboot({ serials: t }), label);
});
$('sbPower').addEventListener('click', async () => {
  const t = requireTargets();
  if (!t.length) return;
  if (!(await confirmBox({ title: `Power off ${plural(t.length, 'headset')}?`, text: 'They must be switched back on by hand.', list: t, ok: 'Power off', icon: 'power' }))) return;
  toastResults('Power off sent', await window.vr.powerOff({ serials: t }), label);
});
$('sbDelete').addEventListener('click', async () => {
  const sel = [...state.selected];
  if (!sel.length) return;
  const ok = await confirmBox({
    title: sel.length === 1 ? `Delete ${label(sel[0])}?` : `Delete ${sel.length} headsets?`,
    text: 'They’re removed from Tobiya Hub along with their names. Saved files are kept. A headset reappears if it’s plugged in or reconnected later.',
    list: sel, ok: 'Delete', icon: 'trash',
  });
  if (!ok) return;
  for (const s of sel) await window.vr.deleteDevice(s);
  const names = sel.map(label);
  clearSelection();
  await pollDevices();
  toast(`Deleted ${names.length === 1 ? names[0] : plural(names.length, 'headset')}`);
});

/* ---------------- confirm dialog ---------------- */

let confirmResolve = null;
function confirmBox({ title, text, list = [], ok = 'Confirm', icon = 'trash' }) {
  $('cfTitle').textContent = title;
  $('cfText').textContent = text || '';
  $('cfIco').innerHTML = ic(icon);
  $('cfOk').textContent = ok;
  $('cfList').innerHTML = list.map((s) => {
    const d = devBy(s);
    return `<div class="drow"><img class="thumb30" src="${modelImage(d)}" alt="" /><span class="nm"><b>${esc(label(s))}</b></span>${isOnline(d) ? '<span class="st miss">Online now</span>' : ''}</div>`;
  }).join('');
  $('confirmMask').classList.add('on');
  return new Promise((res) => { confirmResolve = res; });
}
function closeConfirm(v) {
  $('confirmMask').classList.remove('on');
  confirmResolve?.(v);
  confirmResolve = null;
}
$('cfOk').addEventListener('click', () => closeConfirm(true));
$('cfCancel').addEventListener('click', () => closeConfirm(false));
$('confirmMask').addEventListener('click', (e) => { if (e.target === $('confirmMask')) closeConfirm(false); });

/* ---------------- add headset ---------------- */

function openAdd() {
  $('addIp').value = '';
  $('addStatus').textContent = '';
  $('addMask').classList.add('on');
  setTimeout(() => $('addIp').focus(), 50);
}
const closeAdd = () => $('addMask').classList.remove('on');
async function doAdd() {
  const raw = $('addIp').value.trim();
  const st = $('addStatus');
  if (!raw) { st.className = 'mstatus err'; st.textContent = 'Enter the headset’s IP address.'; return; }
  const hostPort = raw.includes(':') ? raw : `${raw}:5555`;
  $('addGo').disabled = true;
  st.className = 'mstatus';
  st.textContent = `Connecting to ${hostPort}…`;
  try {
    const msg = await window.vr.connectIp(hostPort);
    st.className = 'mstatus ok';
    st.textContent = msg;
    await pollDevices();
    setTimeout(closeAdd, 800);
  } catch (err) {
    st.className = 'mstatus err';
    st.textContent = err.message || String(err);
  }
  $('addGo').disabled = false;
}
$('addGo').addEventListener('click', doAdd);
$('addIp').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });
$('addClose').addEventListener('click', closeAdd);
$('addCancel').addEventListener('click', closeAdd);
$('addMask').addEventListener('click', (e) => { if (e.target === $('addMask')) closeAdd(); });

/* ---------------- per-headset control ---------------- */

const ctl = { items: [], q: '' };
function openCtl(serial) {
  const d = devBy(serial);
  if (!isControllable(d)) return;
  state.ctlSerial = serial;
  $('ctlImg').src = modelImage(d);
  $('ctlHero').src = modelImage(d);
  $('ctlName').textContent = label(serial);
  const c = d.controllers || {};
  $('ctlMeta').textContent = `${d.model || 'Headset'} · ${d.isWifi ? 'Wi-Fi' : 'USB'} · headset ${d.battery ?? '—'}% · controllers ${c.left ?? '—'}% / ${c.right ?? '—'}%`;
  $('ctlWifi').hidden = !!d.isWifi;
  $('ctlSearch').value = '';
  ctl.q = '';
  $('ctlMask').classList.add('on');
  loadCtlList();
}
const closeCtl = () => { state.ctlSerial = null; $('ctlMask').classList.remove('on'); };
async function loadCtlList() {
  const serial = state.ctlSerial;
  $('ctlList').innerHTML = '<div class="loading">loading apps &amp; videos…</div>';
  const [apps, vids] = await Promise.all([
    window.vr.listApps(serial).catch(() => []),
    window.vr.listDeviceVideos(serial).catch(() => []),
  ]);
  if (state.ctlSerial !== serial) return;
  ctl.items = [...apps.map((p) => ({ kind: 'app', id: p, name: prettyApp(p) })), ...vids.map((v) => ({ kind: 'video', id: v, name: v }))];
  renderCtlList();
}
function renderCtlList() {
  const q = ctl.q.toLowerCase();
  const list = ctl.items.filter((x) => !q || `${x.name} ${x.id}`.toLowerCase().includes(q));
  $('ctlList').innerHTML = list.map((x) => `
    <div class="drow" data-kind="${x.kind}" data-id="${esc(x.id)}">
      <span class="appico ${x.kind === 'app' ? hueClass(x.id) : 'hue1'}">${x.kind === 'app' ? esc(x.name[0] || '?') : ic('film')}</span>
      <span class="nm"><b>${esc(x.name)}</b><br><small class="muted">${x.kind === 'app' ? esc(x.id) : '360° video'}</small></span>
      <button class="btn s g">${ic('play')}</button>
    </div>`).join('') || '<div class="loading">Nothing found on this headset.</div>';
}
$('ctlSearch').addEventListener('input', (e) => { ctl.q = e.target.value; renderCtlList(); });
$('ctlList').addEventListener('click', async (e) => {
  const row = e.target.closest('.drow');
  if (!row || !e.target.closest('button') || !state.ctlSerial) return;
  const serials = [state.ctlSerial];
  const r = row.dataset.kind === 'app'
    ? await window.vr.launchApp({ serials, pkg: row.dataset.id })
    : await window.vr.playVideo({ serials, fileName: row.dataset.id });
  toastResults(`${row.dataset.kind === 'app' ? 'Launched' : 'Playing'} ${row.querySelector('b').textContent}`, r, label);
});
const one = () => (state.ctlSerial ? [state.ctlSerial] : []);
$('ctlHome').addEventListener('click', async () => toastResults('Home', await window.vr.sendKey({ serials: one(), code: KEY_HOME }), label));
$('ctlWake').addEventListener('click', async () => toastResults('Wake', await window.vr.sendKey({ serials: one(), code: KEY_WAKE }), label));
$('ctlSleep').addEventListener('click', async () => toastResults('Sleep', await window.vr.sendKey({ serials: one(), code: KEY_SLEEP }), label));
$('ctlLive').addEventListener('click', () => { const s = state.ctlSerial; closeCtl(); window.vr.openWall({ focus: s }); });
$('ctlScrcpy').addEventListener('click', async () => {
  const r = await window.vr.openScrcpy({ serial: state.ctlSerial, name: label(state.ctlSerial) });
  if (!r.ok) toast(`scrcpy: ${r.error} — set its path under Settings → Advanced`, 'err');
});
$('ctlVol').addEventListener('input', (e) => { $('ctlVolV').textContent = `${e.target.value}%`; });
$('ctlVol').addEventListener('change', async (e) => {
  toastResults(`Volume ${e.target.value}%`, await window.vr.setVolume({ serials: one(), value: Math.round((e.target.value / 100) * 15) }), label);
});
$('ctlBri').addEventListener('input', (e) => { $('ctlBriV').textContent = `${e.target.value}%`; });
$('ctlBri').addEventListener('change', async (e) => {
  toastResults(`Brightness ${e.target.value}%`, await window.vr.setBrightness({ serials: one(), value: Math.round(e.target.value * 2.55) }), label);
});
$('ctlApk').addEventListener('click', async () => {
  const res = await window.vr.installApk({ serials: one() });
  if (!res.canceled) { toastResults(`Installed ${res.apk}`, res.results, label); loadCtlList(); }
});
$('ctlWifi').addEventListener('click', async () => {
  const s = state.ctlSerial;
  toast(`Switching ${label(s)} to Wi-Fi…`, 'info');
  try {
    const target = await window.vr.wifiMode(s);
    toast(`${label(s)} is reachable at ${target} — you can unplug the cable`);
    closeCtl();
    pollDevices();
  } catch (err) { toast(`Wi-Fi mode failed: ${err.message || err}`, 'err'); }
});
$('ctlStopApps').addEventListener('click', async () => toastResults('Stopped apps', await window.vr.stopForeground({ serials: one() }), label));
$('ctlPause').addEventListener('click', async () => toastResults('Pause / resume', await window.vr.pauseVideo({ serials: one() }), label));
$('ctlReboot').addEventListener('click', async () => {
  const s = state.ctlSerial;
  if (await confirmBox({ title: `Reboot ${label(s)}?`, ok: 'Reboot', icon: 'refresh' })) toastResults('Reboot sent', await window.vr.reboot({ serials: [s] }), label);
});
$('ctlPower').addEventListener('click', async () => {
  const s = state.ctlSerial;
  if (await confirmBox({ title: `Power off ${label(s)}?`, text: 'It must be switched back on by hand.', ok: 'Power off', icon: 'power' })) toastResults('Power off sent', await window.vr.powerOff({ serials: [s] }), label);
});
$('ctlClose').addEventListener('click', closeCtl);
$('ctlMask').addEventListener('click', (e) => { if (e.target === $('ctlMask')) closeCtl(); });

/* ---------------- Live cast window ---------------- */

function openLive() {
  if (!onlineList().length) { toast('No headsets online to cast.', 'err'); return; }
  window.vr.openWall({});
}
$('btnLive').addEventListener('click', openLive);
$('liveChip').addEventListener('click', () => window.vr.openWall({}));
window.vr.onWallState((open) => { state.wallOpen = open; $('liveChip').hidden = !open; });

/* ---------------- license / Order Checker ---------------- */

function activeSeats() {
  const lic = state.license;
  if (!lic || lic.valid === false || lic.status === 'revoked' || lic.boundElsewhere) return 0;
  if (lic.expiresAt && lic.expiresAt <= Date.now()) return 0;
  return lic.seats || 0;
}

function renderLicense() {
  const lic = state.license;
  const head = { state: $('licState') };
  if (!lic) {
    head.state.className = 'pill r';
    head.state.textContent = 'Not activated';
    $('licSub').textContent = 'Activate the license code your admin issued to manage your headsets.';
    $('licCap').textContent = 'No license';
    $('licUse').textContent = 'Activate a code to control headsets.';
    $('licLeft').textContent = '—';
    $('licExp').textContent = 'No license activated yet.';
    $('licKey').textContent = '—';
    $('licChk').textContent = 'Ask your admin for a code.';
    $('licUseBar').style.width = '0%';
    $('licTermBar').style.width = '0%';
    $('seatRows').innerHTML = '';
    $('seatTxt').textContent = '';
    return;
  }
  const left = timeLeft(lic.expiresAt);
  const revoked = lic.status === 'revoked';
  const ok = lic.valid !== false && !revoked && !lic.boundElsewhere && left.active;
  const cap = ok ? lic.seats : 0;
  const on = onlineList().length;
  head.state.className = `pill ${ok ? (left.soon ? 'a' : 'g') : 'r'}`;
  head.state.innerHTML = ok ? `${ic('dot')}${left.soon ? 'Expiring soon' : 'Active'}` : lic.boundElsewhere ? 'Locked to another PC' : revoked ? 'Revoked' : 'Expired';
  $('licSub').textContent = ok
    ? `Managing up to ${plural(lic.seats, 'headset')} under your current license.`
    : lic.boundElsewhere ? 'This code is active on another computer — ask your admin to reset it.'
      : 'Your license isn’t active — headsets can’t be controlled until it’s renewed.';
  $('ltCap').className = `lt1 ${ok ? 'hi' : 'bad'}`;
  $('licCap').textContent = plural(lic.seats, 'headset');
  $('licUse').textContent = ok
    ? (on > cap ? `${on} online — ${on - cap} over your ${cap}-headset license.` : `${on} of ${cap} licensed headsets online now.`)
    : 'No headsets can be controlled right now.';
  $('licUseBar').style.width = `${cap ? Math.min(100, (on / cap) * 100) : 0}%`;
  $('licLeft').textContent = revoked ? 'Revoked' : lic.boundElsewhere ? 'Locked elsewhere' : left.text;
  $('licLeft').className = !ok ? 'bad' : left.soon ? 'warn' : '';
  $('licExp').textContent = `${left.active ? 'Expires' : 'Expired'} ${new Date(lic.expiresAt).toLocaleDateString()}.`;
  // share of a 1-year horizon still remaining — a visual "getting close" gauge
  $('licTermBar').style.width = `${left.active ? Math.max(3, Math.min(100, (left.daysLeft / 365) * 100)) : 0}%`;
  $('licKey').textContent = lic.code || '—';
  $('licChk').textContent = lic.lastCheckedAt ? `Last checked ${new Date(lic.lastCheckedAt).toLocaleString()}.` : '';

  const rows = state.devices;
  $('seatTxt').textContent = `${Math.min(on, cap)} of ${cap} seats in use · ${plural(rows.length, 'known headset')}`;
  $('seatRows').innerHTML = rows.map((d) => {
    const seat = !isOnline(d) ? '<span class="pill">Not connected</span>'
      : d.withinLicense === false ? `<span class="pill a">${ic('lock')}No seat</span>` : `<span class="pill g">${ic('check')}Licensed</span>`;
    return `<tr><td><div class="cellrow"><img class="thumb30" src="${modelImage(d)}" alt="" /><b>${esc(d.name || d.model || d.serial)}</b></div></td>
      <td class="muted">${esc(d.model || '—')}</td><td class="muted mono">${esc(d.serial)}</td>
      <td class="muted">${isOnline(d) ? 'Online now' : d.lastSeen ? new Date(d.lastSeen).toLocaleString() : '—'}</td><td>${seat}</td></tr>`;
  }).join('') || '<tr><td colspan="5" class="muted">No headsets yet.</td></tr>';
}

/** License codes: upper-case, keep letters/digits, re-insert dashes every 4. */
const fmtKey = (v) => v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32).replace(/(.{4})(?=.)/g, '$1-');

async function activate(code, errEl) {
  const k = fmtKey(code);
  if (k.replace(/-/g, '').length < 8) {
    errEl.className = 'keyerr';
    errEl.textContent = 'Enter the full license code from your order.';
    return null;
  }
  errEl.className = 'keyerr info';
  errEl.textContent = 'Checking with the license server…';
  try {
    state.license = await window.vr.activateLicense({ code: k });
    errEl.textContent = '';
    renderLicense();
    renderSide();
    pollDevices();
    return state.license;
  } catch (err) {
    errEl.className = 'keyerr';
    errEl.textContent = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    return null;
  }
}

['actIn', 'licIn'].forEach((id) => $(id).addEventListener('input', (e) => { e.target.value = fmtKey(e.target.value); e.target.classList.remove('bad'); }));

// first run / inactive license: activation is required before the app can be used
function needsActivation(lic) {
  if (!lic) return true;
  return lic.valid === false || lic.status === 'revoked' || !!lic.boundElsewhere || (lic.expiresAt && lic.expiresAt <= Date.now());
}
function showActivation() {
  const lic = state.license;
  $('actForm').hidden = false;
  $('actOk').hidden = true;
  if (lic) {
    $('actTitle').textContent = lic.boundElsewhere ? 'License in use elsewhere' : lic.status === 'revoked' ? 'License revoked' : 'License expired';
    $('actText').textContent = lic.boundElsewhere
      ? 'This code is active on another computer. Ask your admin to reset it, or enter a different code.'
      : 'Enter a renewed license code from your admin to keep using Tobiya Hub.';
    $('actIn').value = '';
  }
  $('actScr').classList.add('on');
  setTimeout(() => $('actIn').focus(), 60);
}
$('actGo').addEventListener('click', async () => {
  $('actGo').disabled = true;
  const lic = await activate($('actIn').value, $('actErr'));
  $('actGo').disabled = false;
  if (!lic) { $('actIn').classList.add('bad'); return; }
  const left = timeLeft(lic.expiresAt);
  $('okCap').textContent = plural(lic.seats, 'headset');
  $('okExp').textContent = new Date(lic.expiresAt).toLocaleDateString();
  $('okLeft').textContent = left.text.replace(/, .*/, '').replace(' left', '');
  $('actForm').hidden = true;
  $('actOk').hidden = false;
});
$('actIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('actGo').click(); });
$('actStart').addEventListener('click', () => $('actScr').classList.remove('on'));

$('btnActivate').addEventListener('click', () => {
  $('licIn').value = '';
  $('licErr').textContent = '';
  $('licMask').classList.add('on');
  setTimeout(() => $('licIn').focus(), 50);
});
$('licGo').addEventListener('click', async () => {
  $('licGo').disabled = true;
  const lic = await activate($('licIn').value, $('licErr'));
  $('licGo').disabled = false;
  if (lic) { $('licMask').classList.remove('on'); toast(`License activated — ${plural(lic.seats, 'headset')}`); }
});
$('licIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('licGo').click(); });
$('licCancel').addEventListener('click', () => $('licMask').classList.remove('on'));
$('licMask').addEventListener('click', (e) => { if (e.target === $('licMask')) $('licMask').classList.remove('on'); });
$('licCopy').addEventListener('click', async () => {
  if (!state.license?.code) return;
  await navigator.clipboard.writeText(state.license.code).catch(() => {});
  toast('License code copied');
});
$('licRecheck').addEventListener('click', async () => {
  if (!state.license?.code) return;
  const tmp = document.createElement('div');
  const lic = await activate(state.license.code, tmp);
  if (lic) toast('License is valid');
  else toast(tmp.textContent || 'Could not check the license', 'err');
  if (needsActivation(state.license)) showActivation();
});

/* ---------------- Content library ---------------- */

const content = { tab: 'apps', q: '', sel: null, apps: new Map(), vids: new Map(), targets: [], loading: false, xfer: null };

async function loadContent(force = false) {
  const t = targetSerials();
  $('cTarget').textContent = t.length ? `Targeting ${targetLabel()}` : 'No headsets online';
  const key = t.join('|');
  if (!force && key === content.targets.join('|') && (content.apps.size || content.vids.size || !t.length)) { renderContent(); return; }
  content.targets = t;
  content.loading = true;
  renderContent();
  const [apps, vids] = await Promise.all([
    Promise.all(t.map((s) => window.vr.listApps(s).catch(() => []))),
    Promise.all(t.map((s) => window.vr.listDeviceVideos(s).catch(() => []))),
  ]);
  content.apps = new Map(t.map((s, i) => [s, new Set(apps[i])]));
  content.vids = new Map(t.map((s, i) => [s, new Set(vids[i])]));
  content.loading = false;
  renderContent();
}

function contentItems() {
  const src = content.tab === 'apps' ? content.apps : content.vids;
  const all = new Map();
  for (const set of src.values()) for (const id of set) all.set(id, (all.get(id) || 0) + 1);
  const q = content.q.toLowerCase();
  return [...all.entries()]
    .map(([id, count]) => ({ id, count, name: content.tab === 'apps' ? prettyApp(id) : id }))
    .filter((x) => !q || `${x.name} ${x.id}`.toLowerCase().includes(q))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function renderContent() {
  const isA = content.tab === 'apps';
  $('cDropIco').innerHTML = ic(isA ? 'package' : 'film');
  $('cDropTitle').textContent = isA ? 'Drop an .apk here to install it on the targeted headsets' : 'Drop a 360° video here to push it to the targeted headsets';
  $('cDropSub').textContent = isA ? 'Installs in parallel · progress shown per headset' : 'MP4 · MKV · WEBM · MOV — copied to each headset, then playable in sync';
  const n = content.targets.length;
  const list = $('cList');
  if (!n) {
    list.innerHTML = `<div class="empty"><div class="big">${ic('headset')}</div><b>No headsets online</b>Connect headsets on the Devices page to see their apps and videos.</div>`;
  } else if (content.loading) {
    list.innerHTML = '<div class="loading">Reading apps and videos from the headsets…</div>';
  } else {
    const items = contentItems();
    if (isA) {
      list.innerHTML = items.length ? `<div class="apps">${items.map((x) => `
        <button class="ap ${content.sel === x.id ? 'on' : ''}" data-id="${esc(x.id)}">
          <span class="appico ${hueClass(x.id)}">${esc(x.name[0] || '?')}</span>
          <b>${esc(x.name)}</b><small>${esc(x.id)}</small>
          <div class="cov"><i><span data-w="${(x.count / n) * 100}"></span></i>${x.count}/${n}</div>
        </button>`).join('')}</div>`
        : `<div class="empty"><div class="big">${ic('package')}</div><b>${content.q ? 'No apps match' : 'No apps installed yet'}</b>Install an APK to get started.</div>`;
      list.querySelectorAll('.cov span').forEach((s) => { s.style.width = `${s.dataset.w}%`; });
    } else {
      list.innerHTML = items.length ? `<div class="vids">${items.map((x) => `
        <button class="vd ${content.sel === x.id ? 'on' : ''}" data-id="${esc(x.id)}">
          <div class="vt ${hueClass(x.id)}"><em>360°</em>${ic('film')}</div>
          <div class="vb"><b>${esc(x.name)}</b><small>On ${x.count} of ${n} headset${n === 1 ? '' : 's'}</small></div>
        </button>`).join('')}</div>`
        : `<div class="empty"><div class="big">${ic('film')}</div><b>${content.q ? 'No videos match' : 'No videos on these headsets'}</b>Push a 360° video to get started.</div>`;
    }
  }
  renderContentPanel();
}

function renderContentPanel() {
  const p = $('cPanel');
  const isA = content.tab === 'apps';
  const T = content.targets;
  const id = content.sel;
  const src = isA ? content.apps : content.vids;
  const xferHtml = content.xfer ? renderXfer() : '';
  if (!id) {
    p.innerHTML = `<div class="hd"><span class="appico">${ic(isA ? 'gamepad' : 'film')}</span><div class="sp"><h3>${isA ? 'Pick an app' : 'Pick a video'}</h3><span class="muted">${isA ? 'Launch or stop it on the targeted headsets' : 'Play it in sync on the targeted headsets'}</span></div></div>
      <div class="bd">${xferHtml}<div class="lbl"><span>Target headsets</span><span>${T.length}</span></div>
      <div class="dlist">${T.map((s) => `<div class="drow"><img class="thumb30" src="${modelImage(devBy(s))}" alt="" /><span class="nm">${esc(label(s))}</span></div>`).join('') || '<span class="muted">None online</span>'}</div>
      ${isA ? '' : `<div class="grid2"><button class="btn c" id="cpPause">${ic('playpause')}Pause / resume</button><button class="btn d c" id="cpStopV">${ic('stop')}Stop &amp; home</button></div>`}</div>`;
  } else {
    const have = T.filter((s) => src.get(s)?.has(id));
    const name = isA ? prettyApp(id) : id;
    p.innerHTML = `<div class="hd"><span class="appico ${hueClass(id)}">${isA ? esc(name[0] || '?') : ic('film')}</span><div class="sp"><h3>${esc(name)}</h3><span class="muted">${isA ? esc(id) : '360° video'}</span></div></div>
      <div class="bd">${xferHtml}<div class="lbl"><span>Target headsets</span><span>${have.length} of ${T.length} ${isA ? 'have it' : 'ready'}</span></div>
      <div class="dlist">${T.map((s) => `<div class="drow"><img class="thumb30" src="${modelImage(devBy(s))}" alt="" /><span class="nm">${esc(label(s))}</span>${src.get(s)?.has(id) ? `<span class="st ok">${ic('check')}${isA ? 'Installed' : 'Ready'}</span>` : '<span class="st miss">Missing</span>'}</div>`).join('')}</div>
      ${isA
        ? `<div class="grid2"><button class="btn g c" id="cpLaunch" ${have.length ? '' : 'disabled'}>${ic('play')}Launch${have.length < T.length ? ` on ${have.length}` : ''}</button><button class="btn d c" id="cpStop" ${have.length ? '' : 'disabled'}>${ic('stop')}Force stop</button>
           ${have.length < T.length ? `<button class="btn c span2" id="cpInstall">${ic('upload')}Install APK on ${T.length - have.length} missing…</button>` : ''}</div>`
        : `<div class="grid2"><button class="btn p c span2" id="cpPlay" ${have.length ? '' : 'disabled'}>${ic('play')}${have.length > 1 ? `Play in sync on ${have.length}` : 'Play'}</button>
           <button class="btn c" id="cpPause">${ic('playpause')}Pause / resume</button><button class="btn d c" id="cpStopV">${ic('stop')}Stop &amp; home</button>
           ${have.length < T.length ? `<button class="btn c span2" id="cpPush">${ic('upload')}Upload to ${T.length - have.length} missing…</button>` : ''}</div>`}
      </div>`;
    const missing = T.filter((s) => !src.get(s)?.has(id));
    $('cpLaunch')?.addEventListener('click', async () => toastResults(`Launched ${name}`, await window.vr.launchApp({ serials: have, pkg: id }), label));
    $('cpStop')?.addEventListener('click', async () => toastResults(`Stopped ${name}`, await window.vr.stopApp({ serials: have, pkg: id }), label));
    $('cpInstall')?.addEventListener('click', () => installApk(missing));
    $('cpPlay')?.addEventListener('click', async () => toastResults(`Playing ${name}`, await window.vr.playVideo({ serials: have, fileName: id }), label));
    $('cpPush')?.addEventListener('click', () => pushVideo(missing));
  }
  $('cpPause')?.addEventListener('click', async () => toastResults('Pause / resume', await window.vr.pauseVideo({ serials: T }), label));
  $('cpStopV')?.addEventListener('click', async () => toastResults('Stopped video', await window.vr.stopVideo({ serials: T }), label));
  p.querySelectorAll('.prog i[data-w]').forEach((i) => { i.style.width = `${i.dataset.w}%`; });
}

function renderXfer() {
  const x = content.xfer;
  const rows = [...x.rows.entries()].map(([s, r]) => {
    const cls = r.phase === 'done' ? 'done' : r.phase === 'install' ? 'inst' : '';
    const st = r.phase === 'done' ? `<span class="st ok">${ic('check')}</span>` : r.phase === 'failed' ? `<span class="st bad">${ic('x')}</span>`
      : r.phase === 'install' ? '<span class="st run">installing</span>' : `<span class="st run">${r.pct}%</span>`;
    return `<div class="drow"><span class="nm">${esc(label(s))}</span><span class="prog ${cls}"><i data-w="${r.pct}"></i></span>${st}</div>`;
  }).join('');
  const done = [...x.rows.values()].filter((r) => r.phase === 'done' || r.phase === 'failed').length;
  return `<div class="xfer"><div class="hd2"><b class="sp">${x.kind === 'apk' ? 'Installing' : 'Uploading'} ${esc(x.name)}</b><span class="muted">${done}/${x.rows.size}${x.size ? ` · ${prettyBytes(x.size)}` : ''}</span></div>${rows}</div>`;
}

window.vr.onTransferProgress(({ kind, name, size, serial, phase, pct }) => {
  if (!content.xfer || content.xfer.name !== name) content.xfer = { kind, name, size, rows: new Map() };
  content.xfer.rows.set(serial, { phase, pct });
  if (state.page === 'content') renderContentPanel();
});

async function installApk(serials, filePath) {
  if (!serials.length) { toast('No online headsets to install on.', 'err'); return; }
  const res = await window.vr.installApk({ serials, path: filePath || '' });
  if (res.canceled) return;
  toastResults(`Installed ${res.apk}`, res.results, label);
  await loadContent(true);
}
async function pushVideo(serials, filePath) {
  if (!serials.length) { toast('No online headsets to upload to.', 'err'); return; }
  const res = await window.vr.pushVideo({ serials, path: filePath || '' });
  if (res.canceled) return;
  toastResults(`Uploaded ${res.fileName}`, res.results, label);
  content.sel = res.fileName;
  await loadContent(true);
}

wireSeg($('cTab'), (v) => { content.tab = v; content.sel = null; renderContent(); });
$('cSearch').addEventListener('input', (e) => { content.q = e.target.value.trim(); renderContent(); });
$('cRescan').addEventListener('click', () => loadContent(true));
$('cBrowse').addEventListener('click', () => (content.tab === 'apps' ? installApk(content.targets) : pushVideo(content.targets)));
$('cList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-id]');
  if (!b) return;
  content.sel = content.sel === b.dataset.id ? null : b.dataset.id;
  renderContent();
});
const drop = $('cDrop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (!f) return;
  const p = window.vr.pathForFile(f);
  if (/\.apk$/i.test(f.name)) installApk(content.targets, p);
  else if (/\.(mp4|mkv|webm|mov)$/i.test(f.name)) { content.tab = 'videos'; setSeg($('cTab'), 'videos'); pushVideo(content.targets, p); }
  else toast('Drop an .apk or a video file (MP4, MKV, WEBM, MOV).', 'err');
});
// never let a stray drop navigate the window to the file
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

/* ---------------- Files ---------------- */

const files = { type: 'all', dev: '', q: '', sort: 'new', sel: new Set(), list: [] };

/** Headset label from a file name: "<label>_<YYYY-MM-DD_hh-mm-ss>.ext" or legacy "<serial>_rec_<ms>.mp4". */
function fileDevice(name) {
  const m = name.match(/^(.+?)_(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.\w+$/) || name.match(/^(.+?)_rec_\d+\.\w+$/);
  const raw = m ? m[1] : name.replace(/\.\w+$/, '');
  const d = state.devices.find((x) => x.serial.replace(/[^\w.\-]+/g, '_') === raw || (x.name || '').replace(/[^\w.\-]+/g, '_') === raw);
  return { key: raw, name: d ? label(d.serial) : raw.replace(/_/g, ' '), dev: d };
}

async function loadFiles() {
  const s = await window.vr.getSettings();
  state.settings = s;
  $('fDir').textContent = s.filesDir;
  files.list = (await window.vr.listRecordings()).map((f) => ({ ...f, ...fileDevice(f.fileName) }));
  for (const n of [...files.sel]) if (!files.list.some((f) => f.fileName === n)) files.sel.delete(n);
  const devs = [...new Map(files.list.map((f) => [f.key, f.name])).entries()];
  const cur = $('fDev').value;
  $('fDev').innerHTML = '<option value="">All headsets</option>' + devs.map(([k, n]) => `<option value="${esc(k)}">${esc(n)}</option>`).join('');
  $('fDev').value = devs.some(([k]) => k === cur) ? cur : '';
  files.dev = $('fDev').value;
  renderFiles();
}

function shownFiles() {
  const q = files.q.toLowerCase();
  return files.list
    .filter((f) => (files.type === 'all' || f.kind === files.type) && (!files.dev || f.key === files.dev) && (!q || `${f.fileName} ${f.name}`.toLowerCase().includes(q)))
    .sort((a, b) => (files.sort === 'old' ? a.mtime - b.mtime : files.sort === 'big' ? b.size - a.size : b.mtime - a.mtime));
}

function renderFiles() {
  const v = files.list.filter((f) => f.kind === 'video').length;
  $('fCounts').textContent = `${plural(v, 'recording')} · ${plural(files.list.length - v, 'screenshot')} · ${prettyBytes(files.list.reduce((a, f) => a + f.size, 0))}`;
  $('nbFiles').textContent = files.list.length;
  const list = shownFiles();
  const wrap = $('fWrap');
  if (!list.length) {
    wrap.innerHTML = `<div class="empty"><div class="big">${ic('folder')}</div><b>${files.list.length ? 'No files match' : 'No files yet'}</b>${files.list.length ? 'Try a different filter.' : 'Open Live cast and press Screenshot or Rec on any headset — captures land here automatically.'}</div>`;
  } else {
    const groups = new Map();
    if (files.sort === 'big') groups.set(`Largest first · ${prettyBytes(list.reduce((a, f) => a + f.size, 0))}`, list);
    else {
      const today = new Date().toDateString();
      const yday = new Date(Date.now() - 86400000).toDateString();
      for (const f of list) {
        const ds = new Date(f.mtime).toDateString();
        const k = ds === today ? 'Today' : ds === yday ? 'Yesterday' : new Date(f.mtime).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(f);
      }
    }
    wrap.innerHTML = [...groups.entries()].map(([k, fs]) => `<div class="fgroup">${esc(k)} · ${fs.length}</div><div class="files${files.sel.size ? ' selecting' : ''}">${fs.map(fileCard).join('')}</div>`).join('');
    wrap.querySelectorAll('video[data-dur]').forEach((vid) => vid.addEventListener('loadedmetadata', () => {
      const du = vid.parentElement.querySelector('.du');
      if (du && isFinite(vid.duration)) du.textContent = mmss(vid.duration);
    }, { once: true }));
  }
  const n = files.sel.size;
  $('fSelTxt').textContent = n ? `${n} selected` : '';
  $('fExport').hidden = !n;
  $('fDelete').hidden = !n;
}

function fileCard(f) {
  const sel = files.sel.has(f.fileName);
  const media = f.kind === 'video'
    ? `<video src="${esc(f.url)}#t=1" preload="metadata" muted data-dur></video>`
    : `<img src="${esc(f.url)}" alt="" loading="lazy" />`;
  return `<div class="fc${sel ? ' sel' : ''}" data-f="${esc(f.fileName)}">
    <div class="th">${ic(f.kind === 'video' ? 'film' : 'image')}${media}
      <span class="ty ${f.kind === 'video' ? 'v' : ''}">${f.kind === 'video' ? `${ic('rec')}VIDEO` : `${ic('camera')}PNG`}</span>
      ${f.kind === 'video' ? '<span class="du">—</span>' : ''}
      <div class="play"><span>${ic(f.kind === 'video' ? 'play' : 'expand')}</span></div>
      <button class="fck" title="Select">${sel ? ic('check') : ''}</button></div>
    <div class="fb"><img class="thumb30" src="${modelImage(f.dev)}" alt="" /><div class="tx"><b title="${esc(f.fileName)}">${esc(f.fileName)}</b>
      <small>${esc(f.name)} · ${new Date(f.mtime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${prettyBytes(f.size)}</small></div>
      <button class="more" title="Show in folder">${ic('folder')}</button></div></div>`;
}

$('fWrap').addEventListener('click', (e) => {
  const c = e.target.closest('.fc');
  if (!c) return;
  const name = c.dataset.f;
  if (e.target.closest('.fck') || e.ctrlKey) {
    if (files.sel.has(name)) files.sel.delete(name); else files.sel.add(name);
    renderFiles();
  } else if (e.target.closest('.more')) {
    window.vr.showFile(name);
  } else openViewer(name);
});
wireSeg($('fType'), (v) => { files.type = v; renderFiles(); });
wireSeg($('fSort'), (v) => { files.sort = v; renderFiles(); });
$('fDev').addEventListener('change', (e) => { files.dev = e.target.value; renderFiles(); });
$('fSearch').addEventListener('input', (e) => { files.q = e.target.value.trim(); renderFiles(); });
$('fOpen').addEventListener('click', () => window.vr.openRecordingsFolder());
$('fChange').addEventListener('click', changeFilesDir);
$('fExport').addEventListener('click', async () => {
  const r = await window.vr.exportFiles([...files.sel]);
  if (!r.canceled) toast(`Exported ${plural(r.copied, 'file')} to ${r.dir}`);
});
$('fDelete').addEventListener('click', async () => {
  const names = [...files.sel];
  if (!(await confirmBox({ title: `Delete ${plural(names.length, 'file')}?`, text: 'They’re removed from disk. This can’t be undone.', ok: 'Delete', icon: 'trash' }))) return;
  const n = await window.vr.deleteRecording(names);
  files.sel.clear();
  toast(`Deleted ${plural(n, 'file')}`);
  loadFiles();
});
async function changeFilesDir() {
  const r = await window.vr.chooseFilesDir();
  if (!r.canceled) { toast(`Files will be saved to ${r.dir}`); loadFiles(); renderSettings(); }
}

let fvName = null;
function openViewer(name) {
  const list = shownFiles();
  const f = list.find((x) => x.fileName === name);
  if (!f) return;
  fvName = name;
  $('fvDev').src = modelImage(f.dev);
  $('fvName').textContent = f.fileName;
  $('fvMeta').textContent = `${f.name} · ${new Date(f.mtime).toLocaleString()} · ${prettyBytes(f.size)}`;
  const box = $('fvBox');
  box.querySelector('img, video')?.remove();
  const el = document.createElement(f.kind === 'video' ? 'video' : 'img');
  el.src = f.url;
  if (f.kind === 'video') { el.controls = true; el.autoplay = true; }
  box.appendChild(el);
  $('fvMask').classList.add('on');
}
function closeViewer() {
  $('fvBox').querySelector('video')?.pause();
  $('fvBox').querySelector('img, video')?.remove();
  $('fvMask').classList.remove('on');
  fvName = null;
}
function stepViewer(dir) {
  const list = shownFiles();
  const i = list.findIndex((x) => x.fileName === fvName);
  if (i < 0 || !list.length) return;
  openViewer(list[(i + dir + list.length) % list.length].fileName);
}
$('fvPrev').addEventListener('click', () => stepViewer(-1));
$('fvNext').addEventListener('click', () => stepViewer(1));
$('fvClose').addEventListener('click', closeViewer);
$('fvMask').addEventListener('click', (e) => { if (e.target === $('fvMask')) closeViewer(); });
$('fvShow').addEventListener('click', () => window.vr.showFile(fvName));
$('fvOpen').addEventListener('click', () => window.vr.playRecording(fvName));
$('fvDel').addEventListener('click', async () => {
  const name = fvName;
  if (!(await confirmBox({ title: 'Delete this file?', text: name, ok: 'Delete', icon: 'trash' }))) return;
  closeViewer();
  await window.vr.deleteRecording([name]);
  toast('File deleted');
  loadFiles();
});

/* ---------------- Insights ---------------- */

const insights = { days: 7, stats: null, q: '' };
async function loadInsights() {
  const since = insights.days ? (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() - (insights.days - 1) * 86400000; })() : 0;
  insights.stats = await window.vr.getStats({ since });
  renderInsights();
}
function hbars(el, rows, fmt) {
  const max = Math.max(1, ...rows.map((r) => r.v));
  el.innerHTML = rows.length
    ? rows.map((r) => `<div class="hbar"><span class="l" title="${esc(r.l)}">${esc(r.l)}</span><span class="t"><i data-w="${(r.v / max) * 100}"></i></span><span class="v">${esc(fmt(r.v))}</span></div>`).join('')
    : '<div class="muted">Nothing recorded in this period.</div>';
  el.querySelectorAll('i[data-w]').forEach((i) => { i.style.width = `${i.dataset.w}%`; });
}
function renderInsights() {
  const s = insights.stats;
  if (!s) return;
  $('iUsage').textContent = fmtDuration(s.totals.totalMs);
  $('iSessions').textContent = s.totals.sessions;
  $('iLaunches').textContent = s.totals.launches;
  $('iAvg').textContent = s.totals.sessions ? fmtDuration(s.totals.totalMs / s.totals.sessions) : '—';

  const days = s.trend.usageMs;
  const maxH = Math.max(0.5, ...days.map((ms) => ms / 3600000));
  $('iSpark').innerHTML = days.map((ms, i) => {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (days.length - 1 - i));
    const h = ms / 3600000;
    return `<div class="col" title="${d.toLocaleDateString()} · ${h.toFixed(1)} h"><i data-h="${(h / maxH) * 100}"></i><span>${d.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 2)}</span></div>`;
  }).join('');
  $('iSpark').querySelectorAll('i[data-h]').forEach((i) => { i.style.height = `${i.dataset.h}%`; });

  hbars($('iTop'), s.content.slice(0, 6).map((c) => ({ l: c.kind === 'app' ? prettyApp(c.content) : c.content, v: c.count })), (v) => `${v}×`);
  hbars($('iPer'), s.devices.slice(0, 8).map((d) => ({ l: d.name, v: d.totalMs })), fmtDuration);
  renderEvents();
}
function evRow(e) {
  const kind = e.type === 'online' ? ['on', 'online'] : e.type === 'offline' ? ['off', 'offline'] : [e.kind === 'video' ? 'video' : 'app', e.kind === 'video' ? 'video' : 'app'];
  const detail = e.type === 'launch' ? (e.kind === 'app' ? prettyApp(e.content) : e.content) : e.note || '';
  return { html: `<tr><td class="muted">${new Date(e.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td><td>${esc(e.name || label(e.serial))}</td><td><span class="ev ${kind[0]}">${kind[1]}</span></td><td class="muted">${esc(detail)}</td></tr>`, text: `${e.name || label(e.serial)} ${kind[1]} ${detail}`.toLowerCase() };
}
function renderEvents() {
  const q = insights.q.toLowerCase();
  const rows = (insights.stats?.recent || []).map(evRow).filter((r) => !q || r.text.includes(q)).slice(0, 120);
  $('iEvents').innerHTML = rows.map((r) => r.html).join('') || '<tr><td class="muted">No events in this period.</td></tr>';
}
wireSeg($('iRange'), (v) => { insights.days = +v; loadInsights(); });
$('iFilter').addEventListener('input', (e) => { insights.q = e.target.value.trim(); renderEvents(); });
$('iExport').addEventListener('click', () => {
  const s = insights.stats;
  if (!s) return;
  const csv = [['time', 'headset', 'event', 'detail'], ...s.recent.map((e) => [new Date(e.ts).toISOString(), e.name || label(e.serial), e.type === 'launch' ? `launch ${e.kind}` : e.type, e.content || e.note || ''])]
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `tobiya-hub-events-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
$('iClear').addEventListener('click', async () => {
  if (!(await confirmBox({ title: 'Clear all usage data?', text: 'Sessions, launches and events are deleted. This can’t be undone.', ok: 'Clear data', icon: 'trash' }))) return;
  await window.vr.clearStats();
  toast('Usage data cleared');
  loadInsights();
});

/* ---------------- Settings ---------------- */

const QUALITY = { 2: '2 Mbps per headset · best for 8+ headsets or weak Wi-Fi', 4: '4 Mbps per headset · good for up to 8 headsets', 8: '8 Mbps per headset · sharpest picture, needs strong 5 GHz Wi-Fi' };
function renderSettings() {
  const s = state.settings;
  if (!s) return;
  const q = String(s.castBitrate);
  setSeg($('sQual'), QUALITY[q] ? q : '');
  $('sQualCap').textContent = QUALITY[q] || `Custom · ${s.castBitrate} Mbps per headset`;
  setSeg($('sEye'), s.singleEye === false ? 'both' : s.castEye);
  setSeg($('sFit'), s.castFit);
  const trim = Math.round((s.castTrim || 0) * 100);
  $('sTrim').value = trim;
  $('sTrimV').textContent = `${trim}%`;
  $('sDir').textContent = s.filesDir;
  $('sAdb').textContent = s.adbAuto ? `Found automatically · ${s.adbResolved}` : s.adbResolved;
  $('sReconnect').classList.toggle('off', !s.reconnectWifi);
  $('sVersion').textContent = `Tobiya Hub ${s.appVersion}`;
  $('sFoot').textContent = `Tobiya Hub ${s.appVersion}`;
  if (document.activeElement !== $('sBitrate')) $('sBitrate').value = s.castBitrate;
  if (document.activeElement !== $('sSize')) $('sSize').value = s.castSize || '';
  if (document.activeElement !== $('sTilt')) $('sTilt').value = s.castTilt || '';
  if (document.activeElement !== $('sScrcpy')) $('sScrcpy').value = s.scrcpyPath || '';
  drawPreview();
}
async function saveSetting(patch) {
  state.settings = await window.vr.setSettings(patch);
  renderSettings();
}
window.vr.onSettingsChanged((s) => { state.settings = s; if (state.page === 'settings') renderSettings(); });
wireSeg($('sQual'), (v) => saveSetting({ castBitrate: +v }));
wireSeg($('sEye'), (v) => saveSetting(v === 'both' ? { singleEye: false } : { singleEye: true, castEye: v }));
wireSeg($('sFit'), (v) => saveSetting({ castFit: v }));
$('sTrim').addEventListener('input', (e) => { $('sTrimV').textContent = `${e.target.value}%`; state.settings.castTrim = e.target.value / 100; drawPreview(); });
$('sTrim').addEventListener('change', (e) => saveSetting({ castTrim: e.target.value / 100 }));
$('sDirChange').addEventListener('click', changeFilesDir);
$('sAdbChange').addEventListener('click', async () => {
  const r = await window.vr.pickAdb();
  if (!r.canceled) { state.settings = r; renderSettings(); toast('ADB location updated'); }
});
$('sReconnect').addEventListener('click', () => saveSetting({ reconnectWifi: !state.settings.reconnectWifi }));
$('sBitrate').addEventListener('change', (e) => saveSetting({ castBitrate: e.target.value }));
$('sSize').addEventListener('change', (e) => {
  const v = e.target.value.trim();
  if (v && !/^\d{3,4}x\d{3,4}$/.test(v)) { toast('Capture size looks like 1024x576', 'err'); return; }
  saveSetting({ castSize: v });
});
$('sTilt').addEventListener('change', (e) => saveSetting({ castTilt: e.target.value.trim() }));
$('sScrcpy').addEventListener('change', (e) => saveSetting({ scrcpyPath: e.target.value.trim() }));

/* Eye preview: one still frame from the first online headset, re-drawn with
   the current eye / fit / trim / tilt — the same painter the Live cast uses. */
const preview = { img: null, dev: null, det: null };
async function refreshPreview() {
  const d = onlineList().find(isControllable);
  if (!d) { preview.img = null; drawPreview(); return; }
  try {
    const b64 = await window.vr.screenshot(d.serial);
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    preview.img = img;
    preview.dev = d;
    preview.det = new StereoDetector();
    preview.det.stereo = preview.det.measure(img, img.naturalWidth, img.naturalHeight) ?? true;
  } catch { preview.img = null; }
  drawPreview();
}
function drawPreview() {
  $('sPrevPh').hidden = !!preview.img;
  if (!preview.img) return;
  const s = state.settings;
  const w = preview.img.naturalWidth;
  const h = preview.img.naturalHeight;
  const one = s.singleEye !== false && preview.det.stereo !== false;
  drawEyeFrame($('sPrev'), preview.img, one && s.castEye === 'right' ? w / 2 : 0, one ? w / 2 : w, h, tiltFor(preview.dev, s), { fit: s.castFit, trim: s.castTrim });
}

/* ---------------- auto-update ---------------- */

const upd = { status: 'idle', version: '', pct: 0, manual: false };
function renderUpdate() {
  const el = $('updateToast');
  if (upd.status === 'downloading') {
    el.hidden = false;
    el.innerHTML = `<b>${ic('download')} Downloading update v${esc(upd.version)}… ${upd.pct}%</b><div class="prog"><i></i></div>`;
    el.querySelector('.prog').classList.add('wide-in');
    el.querySelector('.prog i').style.width = `${upd.pct}%`;
  } else if (upd.status === 'ready') {
    el.hidden = false;
    el.innerHTML = `<b>${ic('bell')} Update v${esc(upd.version)} ready</b><p>Restart Tobiya Hub to finish installing.</p>
      <div class="acts"><button class="btn s" id="updLater">Later</button><button class="btn s p" id="updGo">Restart &amp; install</button></div>`;
    $('updLater').addEventListener('click', () => { el.hidden = true; });
    $('updGo').addEventListener('click', () => window.vr.installUpdate());
  } else el.hidden = true;
}
window.vr.onUpdateAvailable((info) => { upd.status = 'downloading'; upd.version = info.version; upd.pct = 0; renderUpdate(); });
window.vr.onUpdateProgress((pct) => { upd.pct = pct; if (upd.status === 'downloading') renderUpdate(); });
window.vr.onUpdateDownloaded((info) => { upd.status = 'ready'; upd.version = info.version; renderUpdate(); });
window.vr.onUpdateNone(() => { if (upd.manual) toast('Tobiya Hub is up to date'); upd.manual = false; });
window.vr.onUpdateError((msg) => { if (upd.manual) toast(`Update check failed: ${msg}`, 'err'); upd.manual = false; upd.status = 'idle'; renderUpdate(); });
$('sUpdate').addEventListener('click', async () => {
  upd.manual = true;
  toast('Checking for updates…', 'info');
  const r = await window.vr.checkForUpdates();
  if (r?.skipped) { toast(r.reason, 'err'); upd.manual = false; }
});

/* ---------------- keyboard ---------------- */

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('confirmMask').classList.contains('on')) closeConfirm(false);
  else if ($('fvMask').classList.contains('on')) closeViewer();
  else if ($('ctlMask').classList.contains('on')) closeCtl();
  else if ($('addMask').classList.contains('on')) closeAdd();
  else if ($('licMask').classList.contains('on')) $('licMask').classList.remove('on');
  else if (state.selected.size && state.page === 'devices') clearSelection();
});
document.addEventListener('keydown', (e) => {
  if (!$('fvMask').classList.contains('on')) return;
  if (e.key === 'ArrowLeft') stepViewer(-1);
  if (e.key === 'ArrowRight') stepViewer(1);
});

/* ---------------- boot ---------------- */

(async function boot() {
  state.settings = await window.vr.getSettings();
  $('appVersion').textContent = `Tobiya Hub ${state.settings.appVersion}`;
  try { state.license = await window.vr.getLicense(); } catch { state.license = null; }
  if (needsActivation(state.license)) showActivation();
  state.wallOpen = await window.vr.isWallOpen().catch(() => false);
  $('liveChip').hidden = !state.wallOpen;
  renderLicense();
  await pollDevices();
  window.vr.listRecordings().then((l) => { $('nbFiles').textContent = l.length; }).catch(() => {});
  setInterval(pollDevices, 3000);
  // the license is re-validated in the background every 6 h — reflect any change
  setInterval(async () => {
    try { state.license = await window.vr.getLicense(); } catch { return; }
    renderSide();
    if (state.page === 'order') renderLicense();
    if (needsActivation(state.license) && !$('actScr').classList.contains('on')) showActivation();
  }, 60000);
})();
