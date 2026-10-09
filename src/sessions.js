/**
 * Usage analytics — records when headsets come online/offline and what
 * content is launched, then computes per-device and per-content stats.
 * Stored as a flat JSON event log in data/sessions.json.
 */
const fs = require('fs');
const path = require('path');

let dataDir = null;
let events = [];
let lastOnline = new Set(); // serials seen online in the previous poll
let saveTimer = null;

function init(dir) {
  dataDir = dir;
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'sessions.json');
  try {
    events = JSON.parse(fs.readFileSync(file, 'utf8')).events || [];
  } catch {
    events = [];
  }
  // If the app crashed while devices were online, close those sessions now
  // so time while the app was closed is not counted as usage.
  const open = new Map();
  for (const e of events) {
    if (e.type === 'online') open.set(e.serial, e);
    if (e.type === 'offline') open.delete(e.serial);
  }
  for (const [serial, e] of open) {
    events.push({ ts: e.ts, type: 'offline', serial, name: e.name, note: 'auto-closed' });
  }
  if (open.size) save();
}

function save() {
  if (!dataDir) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const file = path.join(dataDir, 'sessions.json');
    fs.writeFile(file, JSON.stringify({ events }, null, 1), () => {});
  }, 500);
}

/** Called after each device poll with the currently-online devices. */
function recordDeviceStates(devices) {
  const now = Date.now();
  const online = new Set(devices.filter((d) => d.state === 'device').map((d) => d.serial));
  const names = Object.fromEntries(devices.map((d) => [d.serial, d.name || d.model || d.serial]));
  let changed = false;
  for (const serial of online) {
    if (!lastOnline.has(serial)) {
      events.push({ ts: now, type: 'online', serial, name: names[serial] });
      changed = true;
    }
  }
  for (const serial of lastOnline) {
    if (!online.has(serial)) {
      events.push({ ts: now, type: 'offline', serial });
      changed = true;
    }
  }
  lastOnline = online;
  if (changed) save();
}

/** Log an app or video launch on a set of devices. */
function logLaunch(serials, kind, content) {
  const now = Date.now();
  for (const serial of serials) {
    events.push({ ts: now, type: 'launch', kind, serial, content });
  }
  save();
}

/** Close any open sessions (called on app quit). */
function shutdown() {
  const now = Date.now();
  for (const serial of lastOnline) {
    events.push({ ts: now, type: 'offline', serial });
  }
  lastOnline = new Set();
  if (dataDir) {
    clearTimeout(saveTimer);
    const file = path.join(dataDir, 'sessions.json');
    try { fs.writeFileSync(file, JSON.stringify({ events }, null, 1)); } catch {}
  }
}

/** Aggregate stats for the analytics dashboard. */
const TREND_DAYS = 14;

/**
 * Daily buckets for the dashboard sparklines, computed from the same event log
 * everything else here uses — so the trend lines are real history, not a
 * decorative squiggle. A session is attributed to the day it started rather
 * than split across midnight; that keeps "sessions" and "usage" counting the
 * same events.
 */
function dailyTrend(now) {
  const dayMs = 86400000;
  const startOfDay = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const first = startOfDay(now) - (TREND_DAYS - 1) * dayMs;
  const idx = (ts) => Math.floor((startOfDay(ts) - first) / dayMs);
  const blank = () => new Array(TREND_DAYS).fill(0);

  const usageMs = blank();
  const sessions = blank();
  const launches = blank();
  const seenPerDay = Array.from({ length: TREND_DAYS }, () => new Set());
  const openSince = new Map();

  for (const e of events) {
    const i = idx(e.ts);
    if (e.type === 'online') {
      if (!openSince.has(e.serial)) openSince.set(e.serial, e.ts);
      if (i >= 0 && i < TREND_DAYS) {
        sessions[i] += 1;
        seenPerDay[i].add(e.serial);
      }
    } else if (e.type === 'offline' && openSince.has(e.serial)) {
      const start = openSince.get(e.serial);
      openSince.delete(e.serial);
      const si = idx(start);
      if (si >= 0 && si < TREND_DAYS) usageMs[si] += Math.max(0, e.ts - start);
    } else if (e.type === 'launch' && i >= 0 && i < TREND_DAYS) {
      launches[i] += 1;
    }
  }
  // Sessions still open bill their time so far to the day they began
  for (const [, start] of openSince) {
    const si = idx(start);
    if (si >= 0 && si < TREND_DAYS) usageMs[si] += Math.max(0, now - start);
  }

  return {
    days: TREND_DAYS,
    active: seenPerDay.map((s) => s.size),
    usageMs,
    sessions,
    launches,
  };
}

function getStats(deviceNames = {}, sinceMs = 0) {
  const now = Date.now();
  const since = Number(sinceMs) || 0;
  const perDevice = new Map(); // serial -> {name, totalMs, sessions}
  const openSince = new Map();
  // usage time is clipped to the requested window; a session counts if it overlaps it
  const addUsage = (d, start, end) => {
    const from = Math.max(start, since);
    if (end > from) d.totalMs += end - from;
  };

  for (const e of events) {
    if (e.type === 'online') {
      if (!openSince.has(e.serial)) openSince.set(e.serial, e.ts);
      if (!perDevice.has(e.serial)) {
        perDevice.set(e.serial, { serial: e.serial, name: e.name || e.serial, totalMs: 0, sessions: 0 });
      }
    } else if (e.type === 'offline' && openSince.has(e.serial)) {
      const start = openSince.get(e.serial);
      openSince.delete(e.serial);
      const d = perDevice.get(e.serial);
      if (d && e.ts >= since) {
        d.sessions += 1;
        addUsage(d, start, e.ts);
      }
    }
  }
  // Devices still online count time up to now
  for (const [serial, start] of openSince) {
    const d = perDevice.get(serial);
    if (d) {
      d.sessions += 1;
      addUsage(d, start, now);
    }
  }

  const perContent = new Map(); // content -> {content, kind, count}
  for (const e of events) {
    if (e.type === 'launch' && e.ts >= since) {
      const key = e.content;
      if (!perContent.has(key)) perContent.set(key, { content: key, kind: e.kind, count: 0 });
      perContent.get(key).count += 1;
    }
  }

  const devices = [...perDevice.values()]
    .filter((d) => d.sessions > 0)
    .map((d) => ({ ...d, name: deviceNames[d.serial] || d.name }))
    .sort((a, b) => b.totalMs - a.totalMs);
  const content = [...perContent.values()].sort((a, b) => b.count - a.count);
  const recent = events.filter((e) => e.ts >= since).slice(-200).reverse();

  return {
    devices,
    content,
    recent,
    trend: dailyTrend(now),
    totals: {
      totalMs: devices.reduce((s, d) => s + d.totalMs, 0),
      sessions: devices.reduce((s, d) => s + d.sessions, 0),
      launches: events.filter((e) => e.type === 'launch' && e.ts >= since).length,
      activeNow: lastOnline.size,
    },
  };
}

function clearAll() {
  events = [];
  lastOnline = new Set();
  save();
}

module.exports = { init, recordDeviceStates, logLaunch, getStats, shutdown, clearAll };
