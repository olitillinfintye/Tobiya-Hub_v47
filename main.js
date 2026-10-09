/**
 * Tobiya Hub — Electron main process.
 * Orchestrates ADB device management, remote commands, screen capture,
 * 360° video deployment and usage analytics for up to 8+ headsets.
 */
const { app, BrowserWindow, ipcMain, dialog, shell: eshell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { spawn, exec } = require('child_process');
const adb = require('./src/adb');
const sessions = require('./src/sessions');
const caster = require('./src/caster');

// Packaged builds live inside a read-only app bundle — keep data in userData.
const DATA_DIR = app.isPackaged
  ? path.join(app.getPath('userData'), 'data')
  : path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

let win = null;
let config = {
  deviceNames: {},   // serial -> friendly name
  adbPath: '',       // blank = use "adb" from PATH
  scrcpyPath: '',    // blank = use "scrcpy" from PATH (optional)
  thumbInterval: 2000,
  castBitrate: 4,    // Mbps per headset for real-time casting
  castSize: '',      // e.g. "1024x576"; blank = auto (half of native for big captures)
  singleEye: true,   // crop side-by-side stereo captures to one eye
  castEye: 'left',   // which half of a stereo capture to show ('left' | 'right')
  castFit: 'fill',   // 'fill' = one eye covers the tile edge-to-edge · 'fit' = whole eye, letterboxed
  castTrim: 0.12,    // fraction trimmed off each edge of the eye (hides the black lens border)
  castLayout: 'auto',// live cast grid columns: 'auto' | '2' | '3' | '4'
  castTilt: '',      // degrees of tilt correction; blank = auto per model (Quest 3: 21)
  reconnectWifi: true, // re-attach known Wi-Fi headsets on startup
  filesDir: '',      // where recordings + screenshots go; blank = data/recordings
  captureSizes: {},  // serial -> native capture "WxH" learned from the first cast
  knownDevices: {},  // serial -> {model, product, lastIp, lastSeen} — persistent registry
  aliases: {},       // wifi ip:port serial -> usb serial (same physical headset)
  videos: [],        // file names pushed to headsets this/previous sessions
  license: null,     // { code, seats, expiresAt, status, valid, lastCheckedAt } — issued by the admin, not self-served
};

/** License codes are issued by the admin panel and validated against a
    Supabase project whose anon key is safe to embed here: RLS denies direct
    table access, and validate_license() is a SECURITY DEFINER RPC that only
    ever returns the seats/expiry/status for the one code it's asked about. */
const SUPABASE_URL = 'https://dejfyxtkuexofgnitfvu.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_QF3G1JRnpBDu3JHMuZDWog_h1pS3O-B';
const LICENSE_RECHECK_MS = 6 * 60 * 60 * 1000; // re-validate every 6h in case the admin revoked/changed it

/** Look up a license code against the hosted validator. Resolves to null
    when the code doesn't exist at all (vs. existing but expired/revoked). */
function validateLicenseCode(code, machineId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ p_code: code, p_machine_id: machineId || null });
    const req = https.request(
      `${SUPABASE_URL}/rest/v1/rpc/validate_license`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 10000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`License server returned ${res.statusCode}`));
          try {
            const rows = JSON.parse(data);
            resolve(rows[0] || null);
          } catch {
            reject(new Error('Could not read the license server response'));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('License server timed out')));
    req.write(body);
    req.end();
  });
}

/** A stable per-Windows-install identifier (the registry's MachineGuid),
    hashed before it ever leaves this machine. Used to lock a license code to
    the first computer that activates it — cached after the first read since
    it never changes without a Windows reinstall. */
let cachedMachineId = null;
function getMachineId() {
  if (cachedMachineId) return Promise.resolve(cachedMachineId);
  return new Promise((resolve) => {
    exec('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid /reg:64', (err, stdout) => {
      const m = !err && stdout.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
      const raw = m ? m[1].trim() : null;
      cachedMachineId = raw ? crypto.createHash('sha256').update(raw).digest('hex') : null;
      resolve(cachedMachineId);
    });
  });
}

/** Seats currently usable under the active license — 0 (nothing controllable)
    when there is no license, it expired locally, or the last server check
    marked it invalid (expired/revoked). */
function activeLicenseSeatCap() {
  const lic = config.license;
  if (!lic) return 0;
  if (lic.valid === false) return 0;
  if (lic.expiresAt && lic.expiresAt <= Date.now()) return 0;
  return lic.seats || 0;
}

// serial -> whether devices:list's last pass considered it inside the seat
// cap; control handlers consult this so a UI bypass can't reach a headset
// beyond what's licensed.
let lastDeviceLicenseState = new Map();
let lastOnlineCount = 0;

function assertLicensed(serial) {
  const cap = activeLicenseSeatCap();
  if (cap <= 0) {
    throw new Error('No active license. Activate a license code from your admin in the Order Checker tab.');
  }
  const within = lastDeviceLicenseState.get(serial);
  if (within === false) {
    throw new Error(`This headset is outside your licensed capacity (${cap} seat${cap === 1 ? '' : 's'}). Order more capacity or renew to control it.`);
  }
}

/** Guard for connecting a headset the app hasn't seen yet (no serial to look
    up), so it checks remaining capacity instead of a specific device. */
function assertCapacityAvailable() {
  const cap = activeLicenseSeatCap();
  if (cap <= 0) {
    throw new Error('No active license. Activate a license code from your admin in the Order Checker tab.');
  }
  if (lastOnlineCount >= cap) {
    throw new Error(`You're already using all ${cap} licensed seat${cap === 1 ? '' : 's'}. Order more capacity or renew to connect another headset.`);
  }
}

// A crashed async helper must never raise the white "JavaScript error" dialog.
process.on('uncaughtException', (err) => {
  console.error('[main] uncaught exception:', err);
});

/** Installed apps don't always inherit the dev shell's PATH — if adb isn't
    configured, probe the usual Android SDK locations. */
function autoDetectAdb() {
  const pf86 = process.env['ProgramFiles(x86)'] || '';
  const candidates = [
    // adb shipped inside the installer (works on a PC with no Android SDK)
    path.join(process.resourcesPath || '', 'platform-tools', 'adb.exe'),
    path.join(__dirname, 'build', 'platform-tools', 'adb.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
    path.join(process.env.ProgramFiles || '', 'Android', 'platform-tools', 'adb.exe'),
    path.join(pf86, 'Android', 'android-sdk', 'platform-tools', 'adb.exe'),
    path.join(process.env.ProgramFiles || '', 'Meta Quest Developer Hub', 'resources', 'bin', 'adb.exe'),
    path.join(process.env.ProgramFiles || '', 'Oculus', 'Support', 'oculus-diagnostics', 'adb.exe'),
    path.join(process.env.USERPROFILE || '', 'scrcpy', 'adb.exe'),
    'C:\\platform-tools\\adb.exe',
  ];
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch { /* keep probing */ }
  }
  return '';
}

/** A configured adbPath that no longer exists must not mask the real adb. */
function resolveAdbPath() {
  if (config.adbPath && fs.existsSync(config.adbPath)) return config.adbPath;
  return autoDetectAdb() || 'adb';
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''); // tolerate BOM
    config = { ...config, ...JSON.parse(raw) };
  } catch { /* first run */ }
  config.deviceNames = config.deviceNames || {};
  config.knownDevices = config.knownDevices || {};
  config.aliases = config.aliases || {};
  adb.setAdbPath(resolveAdbPath());
}

function saveConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/** Return every USB/Wi-Fi serial known to represent the same physical headset. */
function relatedDeviceSerials(serial) {
  const related = new Set([serial]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [wifiSerial, usbSerial] of Object.entries(config.aliases || {})) {
      if (!related.has(wifiSerial) && !related.has(usbSerial)) continue;
      if (!related.has(wifiSerial)) {
        related.add(wifiSerial);
        changed = true;
      }
      if (!related.has(usbSerial)) {
        related.add(usbSerial);
        changed = true;
      }
    }
  }
  return [...related];
}

function savedDeviceName(serial) {
  for (const relatedSerial of relatedDeviceSerials(serial)) {
    const name = config.deviceNames[relatedSerial];
    if (name) return name;
  }
  return '';
}

function latestMtimeMs(target) {
  try {
    const stat = fs.statSync(target);
    if (stat.isFile()) return stat.mtimeMs;
    if (!stat.isDirectory()) return 0;

    let latest = stat.mtimeMs;
    for (const entry of fs.readdirSync(target)) {
      latest = Math.max(latest, latestMtimeMs(path.join(target, entry)));
    }
    return latest;
  } catch {
    return 0;
  }
}

function formatBuildStamp(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
  ].join('') + '.' + [
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
  ].join('');
}

function displayAppVersion() {
  const base = app.getVersion();
  if (app.isPackaged) return base;

  const trackedPaths = [
    path.join(__dirname, 'main.js'),
    path.join(__dirname, 'preload.js'),
    path.join(__dirname, 'package.json'),
    path.join(__dirname, 'src'),
    path.join(__dirname, 'ui'),
  ];
  const latest = trackedPaths.reduce((max, target) => Math.max(max, latestMtimeMs(target)), 0);
  return latest ? `${base}+dev.${formatBuildStamp(latest)}` : `${base}+dev`;
}

/* Battery values are polled lazily and cached so the device list stays fast */
const batteryCache = new Map(); // serial -> {level, ts}
async function batteryFor(serial) {
  const cached = batteryCache.get(serial);
  if (cached && Date.now() - cached.ts < 20000) return cached.level;
  const level = await adb.getBattery(serial);
  batteryCache.set(serial, { level, ts: Date.now() });
  return level;
}

/* Controller battery comes from a heavier dumpsys — cache it longer */
const controllerCache = new Map(); // serial -> {value, ts}
async function controllersFor(serial) {
  const cached = controllerCache.get(serial);
  if (cached && Date.now() - cached.ts < 45000) return cached.value;
  const value = await adb.getControllerBattery(serial);
  controllerCache.set(serial, { value, ts: Date.now() });
  return value;
}

/* Foreground app — shown as "Now running" on each device card */
const foregroundCache = new Map(); // serial -> {pkg, ts}
async function foregroundFor(serial) {
  const cached = foregroundCache.get(serial);
  if (cached && Date.now() - cached.ts < 12000) return cached.pkg;
  const pkg = await adb.getForegroundPackage(serial);
  foregroundCache.set(serial, { pkg, ts: Date.now() });
  return pkg;
}

/** Run an ADB action across many devices in parallel, collecting per-device results. */
async function fanOut(serials, fn) {
  const results = await Promise.all(
    serials.map(async (serial) => {
      try {
        assertLicensed(serial);
        const value = await fn(serial);
        return { serial, ok: true, value };
      } catch (e) {
        return { serial, ok: false, error: (e.stderr || e.message || String(e)).trim().slice(0, 400) };
      }
    })
  );
  return results;
}

/** Run `p`, but give up waiting after `ms` — a slow step must never hang boot. */
function withTimeout(p, ms) {
  return Promise.race([Promise.resolve(p).catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
}

/** Re-attach Wi-Fi headsets used before (their last ip:port), in parallel. */
async function reconnectKnownWifi() {
  if (!config.reconnectWifi) return;
  const targets = Object.values(config.knownDevices || {})
    .map((d) => d.lastIp)
    .filter((ip) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip || ''));
  await Promise.all([...new Set(targets)].map((ip) => withTimeout(adb.connect(ip), 4000)));
}

function createWindow() {
  // Boot splash: frameless card that reports each real startup step
  const splash = new BrowserWindow({
    width: 500,
    height: 580,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    center: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splash.loadFile(path.join(__dirname, 'ui', 'splash.html'), { query: { v: app.getVersion() } });
  const splashStep = (i, text) => {
    if (splash.isDestroyed()) return Promise.resolve();
    return splash.webContents.executeJavaScript(`window.setStep && window.setStep(${i}, ${JSON.stringify(text)})`).catch(() => {});
  };
  const splashLoaded = new Promise((r) => splash.webContents.once('did-finish-load', r));

  win = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#070914',
    title: 'Tobiya Hub',
    show: false, // revealed once the splash has finished its steps
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  const winReady = new Promise((r) => win.once('ready-to-show', r));

  (async () => {
    await withTimeout(splashLoaded, 3000);
    const t0 = Date.now();

    await splashStep(0, 'Starting ADB server…');
    await withTimeout(adb.run(['start-server']), 8000);

    await splashStep(1, 'Looking for headsets…');
    await withTimeout(reconnectKnownWifi(), 5000);
    const found = await withTimeout(adb.listDevices(), 6000);
    const online = Array.isArray(found) ? found.filter((d) => d.state === 'device').length : 0;
    await splashStep(1, `Looking for headsets… ${online} found`);

    await splashStep(2, 'Checking license…');
    await withTimeout(revalidateLicense(), 6000);

    await splashStep(3, 'Loading workspace…');
    win.loadFile(path.join(__dirname, 'ui', 'index.html'));
    await winReady;

    // keep the splash up long enough to read, even on a fast machine
    const minShown = 2200 - (Date.now() - t0);
    if (minShown > 0) await new Promise((r) => setTimeout(r, minShown));
    await splashStep(4, 'Ready');
    await new Promise((r) => setTimeout(r, 450));
    try { splash.close(); } catch { /* already closed */ }
    win.show();
    win.focus();
  })();
}

/* ---------------- IPC: devices ---------------- */

/* ---- ADB health: surface errors and self-heal a missed headset ---- */
const adbHealth = { ok: true, error: '', usb: [], fixing: false, lastFix: 0, lastUsbCheck: 0, offlineSince: 0 };

async function healAdb(reason) {
  if (adbHealth.fixing) return;
  adbHealth.fixing = true;
  adbHealth.lastFix = Date.now();
  try {
    console.log('[adb] restarting server:', reason);
    adb.setAdbPath(resolveAdbPath());
    await adb.restartServer();
    await withTimeout(reconnectKnownWifi(), 5000);
  } catch (err) {
    adbHealth.error = friendlyAdbError(err);
  } finally {
    adbHealth.fixing = false;
  }
}

function friendlyAdbError(err) {
  const msg = String(err?.stderr || err?.message || err || '').trim();
  if (err?.code === 'ENOENT') {
    return 'adb.exe was not found. Reinstall Tobiya Hub, or set the path to adb.exe in Settings.';
  }
  if (/version.*doesn't match|killing/i.test(msg)) return 'Another program (Meta Link / Android Studio) started a different adb version. Retrying…';
  return msg.split(/\r?\n/)[0] || 'ADB is not responding.';
}

ipcMain.handle('adb:status', async () => ({
  ok: adbHealth.ok,
  error: adbHealth.error,
  fixing: adbHealth.fixing,
  usb: adbHealth.usb,
  adbPath: adb.getAdbPath(),
}));

ipcMain.handle('adb:fix', async () => {
  await healAdb('manual');
  return { ok: !adbHealth.error };
});

ipcMain.handle('devices:list', async () => {
  let raw = [];
  try {
    raw = await adb.listDevices();
    adbHealth.ok = true;
    adbHealth.error = '';
  } catch (err) {
    adbHealth.ok = false;
    adbHealth.error = friendlyAdbError(err);
    if (err?.code !== 'ENOENT' && Date.now() - adbHealth.lastFix > 8000) healAdb('adb error');
    else if (err?.code === 'ENOENT') adb.setAdbPath(resolveAdbPath());
  }

  // A headset the user has just authorized often stays "unauthorized" in a
  // long-running adb server. Nudge it with `adb reconnect`, then restart the
  // server if that doesn't clear it.
  const pending = raw.filter((d) => d.state === 'unauthorized' || (d.state === 'offline' && !d.isWifi));
  if (pending.length) {
    adbHealth.pendingSince = adbHealth.pendingSince || Date.now();
    const age = Date.now() - adbHealth.pendingSince;
    if (!adbHealth.fixing && age > 4000 && Date.now() - (adbHealth.lastReconnect || 0) > 5000) {
      adbHealth.lastReconnect = Date.now();
      if (age > 20000 && Date.now() - adbHealth.lastFix > 20000) {
        healAdb('headset stuck unauthorized/offline');
      } else {
        adb.run(['reconnect'], { timeout: 8000 }).catch(() => {});
        pending.forEach((d) => adb.run(['-s', d.serial, 'reconnect'], { timeout: 8000 }).catch(() => {}));
      }
    }
  } else {
    adbHealth.pendingSince = 0;
  }

  // adb sometimes reports nothing (or a stuck "offline") while a headset is
  // plugged in — usually a stale server. Cross-check Windows' USB list and
  // restart the server when they disagree.
  const hasOnline = raw.some((d) => d.state === 'device');
  const stuck = raw.some((d) => d.state === 'offline' && !d.isWifi);
  adbHealth.offlineSince = stuck ? (adbHealth.offlineSince || Date.now()) : 0;
  if (!hasOnline && adbHealth.ok && !adbHealth.fixing && Date.now() - adbHealth.lastUsbCheck > 6000) {
    adbHealth.lastUsbCheck = Date.now();
    adb.usbHeadsets().then((usb) => {
      adbHealth.usb = usb;
      const usbSerialsSeen = raw.some((d) => !d.isWifi);
      const needFix = usb.length && (!usbSerialsSeen || (stuck && Date.now() - adbHealth.offlineSince > 6000));
      if (needFix && Date.now() - adbHealth.lastFix > 15000) healAdb('usb headset present but adb has none online');
    }).catch(() => {});
  } else if (hasOnline) {
    adbHealth.usb = [];
  }
  const devices = await Promise.all(
    raw.map(async (d) => ({
      ...d,
      name: savedDeviceName(d.serial),
      battery: d.state === 'device' ? await batteryFor(d.serial) : null,
      controllers: d.state === 'device' ? await controllersFor(d.serial) : { left: null, right: null },
      foreground: d.state === 'device' ? await foregroundFor(d.serial) : null,
    }))
  );
  sessions.recordDeviceStates(devices);

  // Persistent registry: remember every headset we have ever seen so it stays
  // on the Devices page as "Not Connected" after it goes offline.
  let registryChanged = false;
  const now = Date.now();
  for (const d of devices) {
    if (d.state !== 'device') continue;
    const prev = config.knownDevices[d.serial];
    const entry = {
      model: d.model || prev?.model || '',
      product: d.product || prev?.product || '',
      lastIp: d.isWifi ? d.serial : (prev?.lastIp || ''),
      lastSeen: now,
    };
    if (!prev || prev.model !== entry.model || prev.lastIp !== entry.lastIp) registryChanged = true;
    config.knownDevices[d.serial] = entry;
  }
  if (registryChanged) saveConfig();

  // Offline registry entries, hiding wifi/usb aliases of a headset that is online
  const onlineSet = new Set(devices.map((d) => d.serial));
  const hidden = new Set();
  for (const [ipSerial, usbSerial] of Object.entries(config.aliases || {})) {
    if (onlineSet.has(ipSerial)) hidden.add(usbSerial);
    if (onlineSet.has(usbSerial)) hidden.add(ipSerial);
  }
  for (const [serial, info] of Object.entries(config.knownDevices)) {
    if (onlineSet.has(serial) || hidden.has(serial)) continue;
    devices.push({
      serial,
      state: 'offline',
      model: info.model,
      product: info.product,
      isWifi: /:\d+$/.test(serial),
      lastIp: info.lastIp || (/:\d+$/.test(serial) ? serial : ''),
      lastSeen: info.lastSeen,
      name: savedDeviceName(serial),
      battery: null,
      controllers: { left: null, right: null },
      registry: true,
    });
  }

  // Only the first N online headsets (N = licensed seats) are controllable —
  // control IPC handlers consult lastDeviceLicenseState via assertLicensed().
  const cap = activeLicenseSeatCap();
  let onlineIndex = 0;
  const licenseState = new Map();
  for (const d of devices) {
    d.withinLicense = d.state === 'device' ? (++onlineIndex <= cap) : true;
    licenseState.set(d.serial, d.withinLicense);
  }
  lastDeviceLicenseState = licenseState;
  lastOnlineCount = onlineIndex;

  return devices;
});

ipcMain.handle('devices:delete', (e, serial) => {
  delete config.knownDevices[serial];
  delete config.deviceNames[serial];
  for (const [ip, usb] of Object.entries(config.aliases || {})) {
    if (ip === serial || usb === serial) delete config.aliases[ip];
  }
  saveConfig();
  return true;
});

ipcMain.handle('devices:deleteAll', () => {
  config.knownDevices = {};
  config.deviceNames = {};
  config.aliases = {};
  saveConfig();
  return true;
});

ipcMain.handle('devices:rename', (e, payload = {}) => {
  const serial = String(payload.serial || '').trim();
  if (!serial) throw new Error('A device serial is required.');

  const name = String(payload.name || '').trim().slice(0, 30);
  const serials = relatedDeviceSerials(serial);
  for (const relatedSerial of serials) {
    if (name) config.deviceNames[relatedSerial] = name;
    else delete config.deviceNames[relatedSerial];
  }
  saveConfig();
  return { name, serials };
});

ipcMain.handle('devices:wifi', async (e, serial) => {
  assertLicensed(serial);
  const currentName = savedDeviceName(serial);
  const target = await adb.enableWifiAdb(serial);
  // Same physical headset now has two serials — remember the link so the
  // registry never shows it twice.
  config.aliases[target] = serial;
  if (currentName) config.deviceNames[target] = currentName;
  else delete config.deviceNames[target];
  saveConfig();
  return target;
});
ipcMain.handle('devices:connect', async (e, hostPort) => {
  assertCapacityAvailable();
  return adb.connect(hostPort);
});
ipcMain.handle('devices:disconnect', async (e, hostPort) => adb.disconnect(hostPort));

ipcMain.handle('devices:screenshot', async (e, serial) => {
  assertLicensed(serial);
  const buf = await adb.screenshot(serial);
  return buf.toString('base64');
});

/* ---------------- IPC: screen recording + files ---------------- */

const DEFAULT_FILES_DIR = path.join(DATA_DIR, 'recordings');
const MEDIA_EXT = /\.(mp4|png|jpe?g)$/i;
/** Where recordings and screenshots are saved (Settings → Save to). */
function filesDir() {
  const dir = config.filesDir || DEFAULT_FILES_DIR;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
/** Resolve a bare file name inside the files folder — never a path outside it. */
function filePath(fileName) {
  return path.join(filesDir(), path.basename(String(fileName || '')));
}
function fileStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
function fileLabel(serial) {
  return (savedDeviceName(serial) || config.knownDevices[serial]?.model || serial).replace(/[^\w.\-]+/g, '_');
}

const recordings = new Map(); // serial -> {remote, fileName, pid, startedAt}

ipcMain.handle('record:start', async (e, serial) => {
  assertLicensed(serial);
  if (recordings.has(serial)) throw new Error('Already recording this headset.');
  const rec = await adb.startRecording(serial);
  recordings.set(serial, { ...rec, startedAt: Date.now() });
  return { fileName: rec.fileName, startedAt: Date.now() };
});

ipcMain.handle('record:stop', async (e, serial) => {
  const rec = recordings.get(serial);
  if (!rec) throw new Error('Not currently recording this headset.');
  recordings.delete(serial);
  await adb.stopRecording(serial, rec.pid);
  const localPath = path.join(filesDir(), `${fileLabel(serial)}_${fileStamp(new Date(rec.startedAt))}.mp4`);
  await adb.pullFile(serial, rec.remote, localPath);
  await adb.deleteRemoteFile(serial, rec.remote);
  return { localPath, fileName: path.basename(localPath), durationMs: Date.now() - rec.startedAt };
});

ipcMain.handle('record:status', () =>
  [...recordings.entries()].map(([serial, r]) => ({ serial, startedAt: r.startedAt })));

ipcMain.handle('record:openFolder', () => {
  eshell.openPath(filesDir());
  return true;
});

/** Every recording (.mp4) and screenshot (.png/.jpg) in the files folder. */
ipcMain.handle('record:list', () => {
  try {
    const dir = filesDir();
    return fs.readdirSync(dir)
      .filter((f) => MEDIA_EXT.test(f))
      .map((f) => {
        const full = path.join(dir, f);
        const st = fs.statSync(full);
        return {
          fileName: f,
          kind: /\.mp4$/i.test(f) ? 'video' : 'image',
          size: st.size,
          mtime: st.mtimeMs,
          url: pathToFileURL(full).href,
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
});

ipcMain.handle('record:play', (e, fileName) => {
  eshell.openPath(filePath(fileName));
  return true;
});

ipcMain.handle('files:show', (e, fileName) => {
  eshell.showItemInFolder(filePath(fileName));
  return true;
});

ipcMain.handle('record:delete', (e, fileName) => {
  const names = Array.isArray(fileName) ? fileName : [fileName];
  let removed = 0;
  for (const n of names) {
    try { fs.unlinkSync(filePath(n)); removed++; } catch { /* already gone */ }
  }
  return removed;
});

/** Save what the operator sees in a Live cast tile (PNG data URL) as a file. */
ipcMain.handle('files:saveShot', (e, { serial, dataUrl } = {}) => {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('Invalid screenshot data.');
  const out = path.join(filesDir(), `${fileLabel(serial || 'headset')}_${fileStamp()}.png`);
  fs.writeFileSync(out, Buffer.from(m[1], 'base64'));
  return { fileName: path.basename(out) };
});

ipcMain.handle('files:export', async (e, fileNames = []) => {
  const parent = BrowserWindow.fromWebContents(e.sender) || win;
  const { canceled, filePaths } = await dialog.showOpenDialog(parent, {
    title: 'Export files to…',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths.length) return { canceled: true };
  let copied = 0;
  for (const n of fileNames) {
    try { fs.copyFileSync(filePath(n), path.join(filePaths[0], path.basename(n))); copied++; } catch { /* skip */ }
  }
  return { canceled: false, copied, dir: filePaths[0] };
});

ipcMain.handle('files:chooseDir', async (e) => {
  const parent = BrowserWindow.fromWebContents(e.sender) || win;
  const { canceled, filePaths } = await dialog.showOpenDialog(parent, {
    title: 'Save recordings and screenshots to…',
    defaultPath: filesDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths.length) return { canceled: true, dir: filesDir() };
  config.filesDir = filePaths[0];
  saveConfig();
  return { canceled: false, dir: filesDir() };
});

/* ---------------- IPC: apps ---------------- */

ipcMain.handle('apps:list', async (e, serial) => adb.listPackages(serial));

ipcMain.handle('apps:launch', async (e, { serials, pkg }) => {
  const results = await fanOut(serials, (s) => adb.launchPackage(s, pkg));
  sessions.logLaunch(results.filter((r) => r.ok).map((r) => r.serial), 'app', pkg);
  return results;
});

ipcMain.handle('apps:stop', async (e, { serials, pkg }) =>
  fanOut(serials, (s) => adb.forceStop(s, pkg))
);

/** A file dropped onto the window (path from webUtils) — used instead of the
    picker when it exists and has an allowed extension. */
function droppedFile(p, exts) {
  if (typeof p !== 'string' || !p) return null;
  const ext = path.extname(p).slice(1).toLowerCase();
  try {
    return exts.includes(ext) && fs.statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

ipcMain.handle('apps:installDialog', async (e, { serials, path: dropped }) => {
  let apk = droppedFile(dropped, ['apk']);
  if (!apk) {
    const parent = BrowserWindow.fromWebContents(e.sender) || win;
    const { canceled, filePaths } = await dialog.showOpenDialog(parent, {
      title: 'Choose APK to install',
      filters: [{ name: 'Android app', extensions: ['apk'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths.length) return { canceled: true };
    apk = filePaths[0];
  }
  const name = path.basename(apk);
  const size = fs.statSync(apk).size;

  const report = (serial, phase, pct) => {
    if (!e.sender.isDestroyed()) e.sender.send('transfer:progress', { kind: 'apk', name, size, serial, phase, pct });
  };
  serials.forEach((s) => report(s, 'upload', 0));

  const results = await fanOut(serials, (s) =>
    adb.installApk(s, apk, ({ phase, pct }) => report(s, phase, pct))
  );
  for (const r of results) report(r.serial, r.ok ? 'done' : 'failed', 100);

  return { canceled: false, apk: name, results };
});

/* ---------------- IPC: 360 video ---------------- */

ipcMain.handle('video:pickAndPush', async (e, { serials, path: dropped }) => {
  let local = droppedFile(dropped, ['mp4', 'mkv', 'webm', 'mov']);
  if (!local) {
    const parent = BrowserWindow.fromWebContents(e.sender) || win;
    const { canceled, filePaths } = await dialog.showOpenDialog(parent, {
      title: 'Choose 360° video to deploy',
      filters: [{ name: 'Video', extensions: ['mp4', 'mkv', 'webm', 'mov'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths.length) return { canceled: true };
    local = filePaths[0];
  }
  // Sanitize the name: spaces break the shell-side am start URI
  const fileName = path.basename(local).replace(/[^\w.\-]+/g, '_');

  const size = fs.statSync(local).size;
  const report = (serial, phase, pct) => {
    if (!e.sender.isDestroyed()) e.sender.send('transfer:progress', { kind: 'video', name: fileName, size, serial, phase, pct });
  };
  serials.forEach((s) => report(s, 'upload', 0));

  const results = await fanOut(serials, (s) =>
    adb.pushVideo(s, local, fileName, ({ phase, pct }) => report(s, phase, pct))
  );
  for (const r of results) report(r.serial, r.ok ? 'done' : 'failed', 100);

  if (results.some((r) => r.ok) && !config.videos.includes(fileName)) {
    config.videos.push(fileName);
    saveConfig();
  }
  return { canceled: false, fileName, results };
});

ipcMain.handle('video:listKnown', () => config.videos);

ipcMain.handle('video:listOnDevice', async (e, serial) => adb.listPushedVideos(serial));

ipcMain.handle('video:play', async (e, { serials, fileName }) => {
  // Fire all starts in parallel so playback begins as close to in-sync as ADB allows
  const results = await fanOut(serials, (s) => adb.startVideo(s, fileName));
  sessions.logLaunch(results.filter((r) => r.ok).map((r) => r.serial), 'video', fileName);
  return results;
});

ipcMain.handle('video:pauseToggle', async (e, { serials }) =>
  fanOut(serials, (s) => adb.keyevent(s, 85)) // KEYCODE_MEDIA_PLAY_PAUSE
);

ipcMain.handle('video:stop', async (e, { serials }) =>
  fanOut(serials, async (s) => {
    await adb.keyevent(s, 86); // KEYCODE_MEDIA_STOP
    await adb.keyevent(s, 3);  // HOME
  })
);

/* ---------------- IPC: device controls ---------------- */

ipcMain.handle('ctl:volume', async (e, { serials, value }) =>
  fanOut(serials, (s) => adb.setVolume(s, value))
);

ipcMain.handle('ctl:brightness', async (e, { serials, value }) =>
  fanOut(serials, (s) => adb.setBrightness(s, value))
);

ipcMain.handle('ctl:key', async (e, { serials, code }) =>
  fanOut(serials, (s) => adb.keyevent(s, code))
);

ipcMain.handle('ctl:reboot', async (e, { serials }) =>
  fanOut(serials, (s) => adb.reboot(s))
);

ipcMain.handle('ctl:poweroff', async (e, { serials }) =>
  fanOut(serials, (s) => adb.powerOff(s))
);

/* ---------------- IPC: real-time casting ---------------- */

/* ---------------- IPC: stream window ---------------- */

let streamWin = null;

/** Open (or bring forward) the Live cast window. `focus` = a serial to
    enlarge straight away, e.g. from a device card's Live cast button. */
ipcMain.handle('wall:open', (e, opts = {}) => {
  const focus = typeof opts === 'object' && opts ? String(opts.focus || '') : '';
  if (streamWin && !streamWin.isDestroyed()) {
    if (streamWin.isMinimized()) streamWin.restore();
    streamWin.focus();
    streamWin.webContents.send('wall:focus', focus);
    return true;
  }
  streamWin = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#05060b',
    title: 'Tobiya Hub — Live Cast',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  streamWin.removeMenu();
  streamWin.maximize();
  streamWin.loadFile(path.join(__dirname, 'ui', 'stream.html'), { query: { focus } });
  // Capture the webContents now: on 'closed' it is already gone, and we only
  // want to drop *this* window's subscriptions — the Settings preview may
  // still be watching a headset of its own.
  const streamWc = streamWin.webContents;
  broadcastWallState(true);
  streamWin.on('closed', () => {
    caster.stopAll(streamWc);
    streamWin = null;
    broadcastWallState(false);
  });
  return true;
});

ipcMain.handle('wall:isOpen', () => !!(streamWin && !streamWin.isDestroyed()));

function broadcastWallState(open) {
  if (win && !win.isDestroyed()) win.webContents.send('wall:state', open);
}

const AUTO_SCALE_THRESHOLD = 2000000; // px — captures above ~2 MP stream at half size

function castBitrateBps() {
  return Math.max(1, Math.min(20, config.castBitrate || 4)) * 1000000;
}

/** Half of a native capture size, rounded to encoder-friendly multiples of 8. */
function halfSize(w, h) {
  const r8 = (v) => Math.max(160, Math.round(v / 2 / 8) * 8);
  return `${r8(w)}x${r8(h)}`;
}

/** Preferred capture size for a device: explicit setting, else auto-half of known native. */
function castSizeFor(serial) {
  if (config.castSize) return config.castSize;
  const stored = (config.captureSizes || {})[serial];
  if (stored) {
    const [w, h] = stored.split('x').map(Number);
    if (w * h > AUTO_SCALE_THRESHOLD) return halfSize(w, h);
  }
  return '';
}

ipcMain.handle('cast:start', async (e, { serials }) => {
  const licensed = serials.filter((s) => {
    try { assertLicensed(s); return true; } catch { return false; }
  });
  // A dozing headset produces no frames — wake each one before capturing
  await Promise.all(licensed.map((s) => adb.keyevent(s, 224).catch(() => {})));
  for (const s of licensed) {
    // Stream to whichever window asked (the dedicated stream window)
    caster.start(s, e.sender, { bitRate: castBitrateBps(), size: castSizeFor(s) });
  }
  return true;
});

/** The renderer reports each stream's frame size after the first decoded frame.
    First cast of a big-capture device runs native — remember the size and
    restart that one stream at half resolution; later casts start pre-scaled. */
ipcMain.handle('cast:nativeSize', (e, { serial, width, height }) => {
  config.captureSizes = config.captureSizes || {};
  const [pw, ph] = (config.captureSizes[serial] || '0x0').split('x').map(Number);
  if (width * height > pw * ph) {
    config.captureSizes[serial] = `${width}x${height}`;
    saveConfig();
  }
  // Only restart an unscaled stream — a pre-scaled one that is still above the
  // threshold (e.g. Quest 3 half-size) must not be halved again and again.
  if (!config.castSize && width * height > AUTO_SCALE_THRESHOLD &&
      caster.isCasting(serial) && !caster.isScaled(serial)) {
    if (!e.sender.isDestroyed()) e.sender.send('cast:event', serial, 'restart', '');
    // restart() keeps every subscriber attached — tearing the stream down and
    // re-starting it for the reporting window alone would cut off any other.
    caster.restart(serial, { bitRate: castBitrateBps(), size: halfSize(width, height) });
    return { restarted: true };
  }
  return { restarted: false };
});

ipcMain.handle('cast:stop', (e, { serials }) => {
  // Drop only this window's subscription; the headset keeps streaming if
  // another window is still watching it.
  for (const s of serials) caster.stop(s, e.sender);
  return true;
});

/* ---------------- IPC: scrcpy (optional low-latency mirror) ---------------- */

ipcMain.handle('scrcpy:open', async (e, { serial, name }) => {
  assertLicensed(serial);
  const exe = config.scrcpyPath || 'scrcpy';
  try {
    const proc = spawn(exe, ['-s', serial, '--window-title', name || serial, '--max-size', '1024'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    // A missing binary surfaces asynchronously — without this handler the
    // ENOENT becomes an uncaught-exception crash dialog.
    const failed = await new Promise((resolve) => {
      proc.once('error', () => resolve(true));
      proc.once('spawn', () => resolve(false));
      setTimeout(() => resolve(false), 3000);
    });
    if (failed) return { ok: false, error: 'scrcpy not found' };
    proc.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('ctl:stopForeground', async (e, { serials }) =>
  fanOut(serials, (s) => adb.stopForegroundApp(s))
);

/* ---------------- IPC: settings & stats ---------------- */

function publicSettings() {
  return {
    adbPath: config.adbPath,
    scrcpyPath: config.scrcpyPath,
    thumbInterval: config.thumbInterval,
    castBitrate: config.castBitrate,
    castSize: config.castSize,
    singleEye: config.singleEye !== false,
    castEye: config.castEye === 'right' ? 'right' : 'left',
    castFit: config.castFit === 'fit' ? 'fit' : 'fill',
    castTrim: Number.isFinite(config.castTrim) ? config.castTrim : 0.12,
    castLayout: ['auto', '2', '3', '4'].includes(String(config.castLayout)) ? String(config.castLayout) : 'auto',
    castTilt: config.castTilt,
    reconnectWifi: config.reconnectWifi !== false,
    filesDir: filesDir(),
    adbResolved: adb.getAdbPath(),
    adbAuto: !config.adbPath || !fs.existsSync(config.adbPath),
    appVersion: displayAppVersion(),
  };
}

ipcMain.handle('settings:get', () => publicSettings());

/** Partial update: only keys present in `s` change, so the Live cast window
    can flip the eye/fit/trim without resending every other setting. Every
    window is told so a change in one applies everywhere at once. */
ipcMain.handle('settings:set', (e, s = {}) => {
  const has = (k) => Object.prototype.hasOwnProperty.call(s, k);
  if (has('adbPath')) {
    config.adbPath = String(s.adbPath || '').trim();
    adb.setAdbPath(resolveAdbPath());
  }
  if (has('scrcpyPath')) config.scrcpyPath = String(s.scrcpyPath || '').trim();
  if (has('thumbInterval')) config.thumbInterval = Math.max(500, parseInt(s.thumbInterval, 10) || 2000);
  if (has('castBitrate')) config.castBitrate = Math.max(1, Math.min(20, parseFloat(s.castBitrate) || 4));
  if (has('castSize')) config.castSize = /^\d{3,4}x\d{3,4}$/.test(s.castSize || '') ? s.castSize : '';
  if (has('singleEye')) config.singleEye = !!s.singleEye;
  if (has('castEye')) config.castEye = s.castEye === 'right' ? 'right' : 'left';
  if (has('castFit')) config.castFit = s.castFit === 'fit' ? 'fit' : 'fill';
  if (has('castTrim')) config.castTrim = Math.max(0, Math.min(0.3, parseFloat(s.castTrim) || 0));
  if (has('castLayout')) config.castLayout = ['auto', '2', '3', '4'].includes(String(s.castLayout)) ? String(s.castLayout) : 'auto';
  if (has('castTilt')) {
    const tilt = parseFloat(s.castTilt);
    config.castTilt = isNaN(tilt) ? '' : String(Math.max(-45, Math.min(45, tilt)));
  }
  if (has('reconnectWifi')) config.reconnectWifi = !!s.reconnectWifi;
  saveConfig();
  const pub = publicSettings();
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('settings:changed', pub);
  }
  return pub;
});

ipcMain.handle('settings:pickAdb', async (e) => {
  const parent = BrowserWindow.fromWebContents(e.sender) || win;
  const { canceled, filePaths } = await dialog.showOpenDialog(parent, {
    title: 'Locate adb.exe',
    filters: [{ name: 'ADB', extensions: ['exe'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return { canceled: true };
  config.adbPath = filePaths[0];
  adb.setAdbPath(config.adbPath);
  saveConfig();
  return { canceled: false, ...publicSettings() };
});

ipcMain.handle('stats:get', (e, opts = {}) => sessions.getStats(config.deviceNames, opts && opts.since));
ipcMain.handle('stats:clear', () => { sessions.clearAll(); return true; });
ipcMain.handle('data:openFolder', () => { eshell.openPath(DATA_DIR); return true; });

/* ---------------- IPC: license ---------------- */

ipcMain.handle('license:get', () => config.license);

ipcMain.handle('license:activate', async (e, { code } = {}) => {
  const trimmed = String(code || '').trim().toUpperCase();
  if (!trimmed) throw new Error('Enter the license code your admin sent you.');

  const machineId = await getMachineId();
  const row = await validateLicenseCode(trimmed, machineId);
  if (!row) throw new Error('That license code was not found.');
  if (row.bound_elsewhere) {
    throw new Error('This license is already active on another computer. Ask your admin to reset it before using it here.');
  }
  if (!row.valid) throw new Error(`This license is ${row.status === 'revoked' ? 'revoked' : 'expired'} — contact your admin to renew it.`);

  config.license = {
    code: trimmed,
    seats: row.seats,
    expiresAt: new Date(row.expires_at).getTime(),
    status: row.status,
    valid: row.valid,
    boundElsewhere: false,
    lastCheckedAt: Date.now(),
  };
  saveConfig();
  return config.license;
});

/** Re-checks the active code against the server so an admin's revoke/renew
    (or a licence being reset for use on a different machine) is picked up
    without the operator having to re-enter anything. Network failures keep
    the last-known state rather than locking the app out. */
async function revalidateLicense() {
  if (!config.license?.code) return;
  try {
    const machineId = await getMachineId();
    const row = await validateLicenseCode(config.license.code, machineId);
    if (row) {
      config.license.seats = row.seats;
      config.license.expiresAt = new Date(row.expires_at).getTime();
      config.license.status = row.status;
      config.license.valid = row.valid;
      config.license.boundElsewhere = !!row.bound_elsewhere;
    }
    config.license.lastCheckedAt = Date.now();
    saveConfig();
  } catch {
    // offline or the server hiccupped — keep the last-known license state
  }
}

/* ---------------- IPC: auto-update ---------------- */

// Loaded lazily (only in a packaged build, after app.whenReady) — electron-updater
// constructs its updater against `app` as soon as it's required, so requiring it
// any earlier risks running before Electron has finished bootstrapping.
let autoUpdater = null;

function sendUpdateEvent(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** Where built installers live. Must be a PUBLIC repo: end-user machines check
    for updates unauthenticated, and a private repo answers those with a 404. */
const RELEASES_OWNER = 'olitillinfintye';
const RELEASES_REPO = 'Tobiya-Hub-Releases';

/** electron-updater dumps the raw HTTP response (headers, cookies and all) into
    err.message. Boil the cases an operator can act on down to one sentence. */
function describeUpdateError(err) {
  const raw = typeof err === 'string' ? err : String(err?.message || '');
  if (/releases\.atom/.test(raw) && /404/.test(raw)) {
    return 'Could not reach the update feed. This build points at a release location that is no longer available — reinstall the latest version once from the Releases page.';
  }
  if (/404/.test(raw)) return 'No published release was found to update from.';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ENETUNREACH/.test(raw)) {
    return 'No internet connection — could not reach the update server.';
  }
  if (/sha512|checksum/i.test(raw)) return 'The downloaded update failed its integrity check. Try again.';
  return raw.split('\n')[0].slice(0, 200) || 'Update check failed.';
}

function initAutoUpdater() {
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Pin the feed in code as well as in the build config. app-update.yml is baked
  // in at package time, so a build made before the release repo moved keeps
  // pointing at the old one — being explicit here makes the source of truth
  // visible and survives a stale/missing app-update.yml.
  try {
    autoUpdater.setFeedURL({ provider: 'github', owner: RELEASES_OWNER, repo: RELEASES_REPO });
  } catch (err) {
    console.error('[main] could not set update feed:', err);
  }
  autoUpdater.on('checking-for-update', () => sendUpdateEvent('update:checking'));
  autoUpdater.on('update-available', (info) => sendUpdateEvent('update:available', { version: info.version }));
  autoUpdater.on('update-not-available', () => sendUpdateEvent('update:none'));
  autoUpdater.on('download-progress', (p) => sendUpdateEvent('update:progress', Math.round(p.percent)));
  autoUpdater.on('update-downloaded', (info) => sendUpdateEvent('update:downloaded', { version: info.version }));
  autoUpdater.on('error', (err) => sendUpdateEvent('update:error', describeUpdateError(err)));
}

ipcMain.handle('update:check', async () => {
  if (!app.isPackaged || !autoUpdater) {
    return { skipped: true, reason: 'Updates only run in a packaged build, not "npm start".' };
  }
  try {
    await autoUpdater.checkForUpdates();
    return { skipped: false };
  } catch (err) {
    return { skipped: true, reason: describeUpdateError(err) };
  }
});

// Quits and relaunches into the downloaded installer — only valid once
// update:downloaded has fired.
ipcMain.handle('update:install', () => {
  if (autoUpdater) setImmediate(() => autoUpdater.quitAndInstall());
  return true;
});

/* ---------------- lifecycle ---------------- */

app.whenReady().then(() => {
  loadConfig();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  sessions.init(DATA_DIR);
  createWindow(); // the splash sequence starts ADB, reconnects headsets and checks the license

  setInterval(revalidateLicense, LICENSE_RECHECK_MS);

  if (app.isPackaged) {
    initAutoUpdater();
    // Give the window a moment to settle before the first background check.
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 4000);
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
  }
});

app.on('window-all-closed', () => {
  caster.stopAll();
  sessions.shutdown();
  app.quit();
});
