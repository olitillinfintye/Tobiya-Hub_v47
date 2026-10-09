/* Tobiya Hub — helpers shared by the main window and the Live cast window. */

const $ = (id) => document.getElementById(id);

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ---------- toasts ---------- */
function toast(msg, kind = 'ok') {
  let host = $('toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    host.className = 'toasts';
    document.body.appendChild(host);
  }
  const d = document.createElement('div');
  d.className = kind === 'ok' ? '' : kind;
  d.innerHTML = `${ic(kind === 'err' ? 'err' : kind === 'info' ? 'info' : 'ok')}<span>${esc(msg)}</span>`;
  host.appendChild(d);
  setTimeout(() => d.remove(), kind === 'err' ? 7000 : 3200);
  while (host.children.length > 5) host.firstChild.remove();
}

/** Summarise a fan-out result list as one toast. */
function toastResults(action, results, label) {
  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) toast(`${action} · ${plural(ok, 'headset')}`);
  else toast(`${action}: ${ok} ok · failed on ${failed.map((f) => label(f.serial)).join(', ')} — ${failed[0].error || ''}`, 'err');
}

/* ---------- headsets ---------- */
/** Product photo for a detected headset (bundled renders in assets/devices). */
function modelImage(d) {
  const m = `${d?.model || ''} ${d?.product || ''}`.toLowerCase();
  if (m.includes('quest 3s') || m.includes('panther')) return 'assets/devices/quest-3s.png';
  if (m.includes('quest 3') || m.includes('eureka')) return 'assets/devices/quest-3.png';
  if (m.includes('quest pro') || m.includes('seacliff')) return 'assets/devices/quest-pro.png';
  if (m.includes('quest') || m.includes('hollywood') || m.includes('monterey')) return 'assets/devices/quest-2.png';
  if (m.includes('pico') && m.includes('enterprise')) return 'assets/devices/pico-4-ultra-enterprise.png';
  if (m.includes('pico') || m.includes('pvr') || m.includes('a7h') || m.includes('a8')) return 'assets/devices/pico-4-ultra.png';
  if (m.includes('vive') || m.includes('focus') || m.includes('htc')) return 'assets/devices/vive-focus-vision.png';
  if (m.includes('vision pro')) return 'assets/devices/apple-vision-pro.png';
  if (m.includes('galaxy') || m.includes('samsung')) return 'assets/devices/samsung-galaxy-xr.png';
  return 'assets/devices/quest-3.png';
}

/** Tilt correction in degrees: Quest 3 panels are mounted rotated (~21°), so
    raw captures come out diagonal — counter-rotate them upright. */
function tiltFor(d, settings) {
  const override = settings?.castTilt;
  if (override !== '' && override != null && !isNaN(parseFloat(override))) return parseFloat(override);
  const m = `${d?.model || ''} ${d?.product || ''}`.toLowerCase();
  const isQuest3 = (m.includes('quest 3') || m.includes('eureka')) && !m.includes('3s') && !m.includes('panther');
  return isQuest3 ? 21 : 0;
}

const SYSTEM_PKG = /^(com\.oculus\.|com\.meta\.|com\.android\.|android$|com\.pico|com\.pvr\.|com\.bytedance\.|com\.htc\.|com\.samsung\.|com\.google\.)/;
const PLAYER_PKG = /horizonmediaplayer|videoplayer|\.player/i;

/** Readable name from a package id: com.tobiya.solarsystem → Solarsystem. */
function prettyApp(pkg) {
  if (!pkg) return '';
  const parts = pkg.split('.').filter((p) => !/^(com|org|net|io|app|android|oculus|vr|unity3d)$/i.test(p));
  const word = parts[parts.length - 1] || pkg.split('.').pop();
  return word.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

/** What a headset is doing, from its foreground package. */
function nowRunning(pkg) {
  if (!pkg) return { kind: 'home', label: 'Home screen' };
  if (PLAYER_PKG.test(pkg)) return { kind: 'video', label: '360° video player' };
  if (SYSTEM_PKG.test(pkg)) return { kind: 'home', label: 'Home screen' };
  return { kind: 'app', label: prettyApp(pkg), pkg };
}

/** Stable colour class (hue0…hue7) per string, so each app keeps its tile colour. */
function hueClass(s) {
  let h = 0;
  for (const c of String(s || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hue${h % 8}`;
}

function levelClass(pct) {
  return pct == null ? '' : pct < 20 ? 'lv-low' : pct < 50 ? 'lv-mid' : 'lv-ok';
}
const LEVEL_COLOUR = { 'lv-low': '#f87171', 'lv-mid': '#fbbf24', 'lv-ok': '#4ade80' };
/** Paint a conic battery ring element (CSSOM — the CSP blocks inline style attributes). */
function paintRing(el, pct) {
  const col = LEVEL_COLOUR[levelClass(pct)] || '#3a4170';
  el.style.background = `conic-gradient(${col} ${pct || 0}%, var(--panel2) 0)`;
}

/* ---------- formatting ---------- */
function prettyBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
function fmtDuration(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} m`;
}
const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** "46 months, 5 days left" — calendar months, like the license admin issues them. */
function timeLeft(expiresAt) {
  const now = new Date();
  const to = new Date(expiresAt);
  if (to <= now) {
    const ago = Math.max(1, Math.round((now - to) / 86400000));
    return { active: false, text: `Expired ${plural(ago, 'day')} ago`, short: 'expired' };
  }
  let months = (to.getFullYear() - now.getFullYear()) * 12 + to.getMonth() - now.getMonth();
  const anchor = () => { const a = new Date(now); a.setMonth(a.getMonth() + months); return a; };
  if (anchor() > to) months--;
  const days = Math.round((to - anchor()) / 86400000);
  const daysLeft = Math.ceil((to - now) / 86400000);
  const text = months > 0 ? `${plural(months, 'month')}, ${plural(days, 'day')} left` : `${plural(daysLeft, 'day')} left`;
  const short = months > 0 ? `${months} mo ${days} d left` : `${plural(daysLeft, 'day')} left`;
  return { active: true, soon: daysLeft <= 30, daysLeft, text, short };
}

/* ---------- segmented controls ---------- */
/** Wire a .seg group: click selects one button (data-v) and calls onPick(value). */
function wireSeg(el, onPick) {
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    setSeg(el, b.dataset.v);
    onPick(b.dataset.v);
  });
}
function setSeg(el, v) {
  el.querySelectorAll('button[data-v]').forEach((x) => x.classList.toggle('on', x.dataset.v === String(v)));
}

/* ---------- volume popover ----------
   0–100 % for the operator; headsets take 16 steps (0–15), so the value is
   rounded to the nearest step when applied. */
const Volume = (() => {
  const st = { v: 70, orig: 70, anchor: null, targets: () => [], label: () => '', onApply: null };
  let pop;
  function build() {
    pop = document.createElement('div');
    pop.className = 'volpop';
    pop.innerHTML = `
      <div class="vph">${ic('volume')}<b>Volume</b><span class="sp"></span><span class="vtg"></span></div>
      <div class="vbig"><span class="vnum">70</span><small>%</small></div>
      <div class="vrow">
        <button class="vstep vdown" title="Lower 5% (↓)">${ic('minus')}</button>
        <input type="range" class="vrange" min="0" max="100" step="1" value="70">
        <button class="vstep vup" title="Raise 5% (↑)">${ic('plus')}</button>
      </div>
      <div class="vpre"><button data-v="0">Mute</button><button data-v="25">25%</button><button data-v="50">50%</button><button data-v="75">75%</button><button data-v="100">Max</button></div>
      <div class="vft"><span class="muted vstep-note"></span><span class="sp"></span><button class="btn s vcancel">Cancel</button><button class="btn s p vapply">Apply</button></div>`;
    document.body.appendChild(pop);
    pop.querySelector('.vrange').addEventListener('input', (e) => set(+e.target.value));
    pop.querySelector('.vdown').addEventListener('click', () => set(st.v - 5));
    pop.querySelector('.vup').addEventListener('click', () => set(st.v + 5));
    pop.querySelector('.vpre').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) set(+b.dataset.v); });
    pop.addEventListener('wheel', (e) => { e.preventDefault(); set(st.v + (e.deltaY < 0 ? 2 : -2)); }, { passive: false });
    pop.querySelector('.vapply').addEventListener('click', apply);
    pop.querySelector('.vcancel').addEventListener('click', () => close(false));
    document.addEventListener('keydown', (e) => {
      if (!isOpen()) return;
      if (e.key === 'Escape') { e.stopPropagation(); close(false); }
      else if (e.key === 'Enter') apply();
      else if (e.key === 'ArrowUp' || e.key === '+') { e.preventDefault(); set(st.v + 5); }
      else if (e.key === 'ArrowDown' || e.key === '-') { e.preventDefault(); set(st.v - 5); }
    }, true);
    document.addEventListener('mousedown', (e) => {
      if (isOpen() && !e.target.closest('.volpop') && !e.target.closest('[data-vol]')) close(false);
    });
  }
  const isOpen = () => pop && pop.classList.contains('on');
  function paint() {
    const v = st.v;
    pop.querySelector('.vnum').textContent = v;
    const r = pop.querySelector('.vrange');
    r.value = v;
    r.style.background = `linear-gradient(90deg, var(--brand2) ${v}%, var(--panel2) 0)`;
    pop.querySelector('.vbig').classList.toggle('mut', v === 0);
    pop.querySelectorAll('.vpre button').forEach((b) => b.classList.toggle('on', +b.dataset.v === v));
    pop.querySelector('.vstep-note').textContent = `level ${Math.round((v / 100) * 15)}/15`;
    document.querySelectorAll('.volv').forEach((x) => { x.textContent = v === 0 ? 'Muted' : `${v}%`; });
  }
  function set(v) { st.v = Math.max(0, Math.min(100, Math.round(v))); paint(); }
  function open(btn, { targets, label, onApply }) {
    if (!pop) build();
    if (st.anchor === btn && isOpen()) { close(false); return; }
    st.anchor?.classList.remove('open');
    Object.assign(st, { anchor: btn, targets, label, onApply, orig: st.v });
    btn.classList.add('open');
    pop.querySelector('.vtg').textContent = label();
    pop.classList.add('on');
    const r = btn.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    pop.style.top = `${r.bottom + 8 + ph < innerHeight ? r.bottom + 8 : r.top - ph - 8}px`;
    pop.style.left = `${Math.max(12, Math.min(innerWidth - pw - 12, r.left + r.width / 2 - pw / 2))}px`;
    paint();
  }
  function close(keep) {
    if (!keep) set(st.orig);
    pop?.classList.remove('on');
    st.anchor?.classList.remove('open');
    st.anchor = null;
  }
  async function apply() {
    const t = st.targets();
    const v = st.v;
    close(true);
    if (!t.length) { toast('No online headsets to set the volume on.', 'err'); return; }
    const results = await window.vr.setVolume({ serials: t, value: Math.round((v / 100) * 15) });
    st.onApply?.(results, v);
  }
  return { open, close, get value() { return st.v; } };
})();
