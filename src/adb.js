/**
 * ADB wrapper — all headset communication goes through here.
 * Talks to adb.exe via child processes; every function takes a device serial
 * (USB serial or ip:port for Wi-Fi devices).
 */
const { execFile, spawn } = require('child_process');

let adbPath = 'adb';

function setAdbPath(p) {
  if (p && p.trim()) adbPath = p.trim();
}

function getAdbPath() {
  return adbPath;
}

/** Restart the adb server. Clears stale/half-dead servers and version clashes
    (Meta Link and Android Studio ship their own adb and fight over port 5037). */
async function restartServer() {
  await run(['kill-server'], { timeout: 8000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 600));
  await run(['start-server'], { timeout: 15000 });
}

/** Ask Windows whether a Meta/Oculus/Pico/other headset is physically on USB,
    independent of adb. Returns [{name, status}] (empty on error / non-Windows). */
function usbHeadsets() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const ps = "Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | " +
    "Where-Object { $_.InstanceId -match '^USB.VID_(2833|2D40|2D00)' } | " +
    "ForEach-Object { $_.FriendlyName + '|' + $_.Status } | Select-Object -Unique";
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeout: 10000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve([]);
        resolve(String(stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
          .map((l) => { const [name, status] = l.split('|'); return { name, status }; }));
      });
  });
}

function run(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      adbPath,
      args,
      { maxBuffer: 32 * 1024 * 1024, timeout: opts.timeout || 25000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          return reject(err);
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
}

function shell(serial, cmd, opts = {}) {
  return run(['-s', serial, 'shell', cmd], opts);
}

/** Parse `adb devices -l` into [{serial, state, model, product, transport, isWifi}] */
async function listDevices() {
  const { stdout } = await run(['devices', '-l']);
  const devices = [];
  for (const line of stdout.split(/\r?\n/).slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const serial = parts[0];
    const state = parts[1] || 'unknown';
    const info = {};
    for (const p of parts.slice(2)) {
      const idx = p.indexOf(':');
      if (idx > 0) info[p.slice(0, idx)] = p.slice(idx + 1);
    }
    devices.push({
      serial,
      state, // device | offline | unauthorized
      model: (info.model || '').replace(/_/g, ' '),
      product: info.product || '',
      isWifi: /^\d+\.\d+\.\d+\.\d+:\d+$/.test(serial),
    });
  }
  return devices;
}

async function getBattery(serial) {
  try {
    const { stdout } = await shell(serial, 'dumpsys battery', { timeout: 8000 });
    const m = stdout.match(/level:\s*(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

/** Touch-controller battery levels. Quest reports each paired controller in
    `dumpsys OVRRemoteService` as a single line carrying Type and Battery, e.g.
    "Paired device: c23e…, Type: Left, Model: RUBY, …, Battery: 30%, …". */
async function getControllerBattery(serial) {
  const out = { left: null, right: null };
  try {
    const { stdout } = await shell(serial, 'dumpsys OVRRemoteService', { timeout: 12000 });
    const re = /Paired device:.*?Type:\s*(Left|Right).*?Battery:\s*(\d+)\s*%/gi;
    let m;
    while ((m = re.exec(stdout)) !== null) {
      const pct = parseInt(m[2], 10);
      if (!isNaN(pct)) out[m[1].toLowerCase()] = pct;
    }
  } catch { /* not a Quest, or service unavailable */ }
  return out;
}

/** Device Wi-Fi IP (wlan0). Needed to switch a USB device to Wi-Fi ADB. */
async function getIp(serial) {
  try {
    const { stdout } = await shell(serial, 'ip route', { timeout: 8000 });
    const m = stdout.match(/wlan0\s+(?:proto\s+\S+\s+)?src\s+(\d+\.\d+\.\d+\.\d+)/) ||
              stdout.match(/src\s+(\d+\.\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Switch a USB-connected device to Wi-Fi ADB and connect to it.
    Some headsets show a fresh "Allow USB debugging" prompt for the network
    connection — retry for a while so the operator has time to accept it. */
async function enableWifiAdb(serial, port = 5555) {
  const ip = await getIp(serial);
  if (!ip) throw new Error('Could not read the headset’s Wi-Fi IP. Is it connected to Wi-Fi?');
  await run(['-s', serial, 'tcpip', String(port)]);
  await new Promise((r) => setTimeout(r, 2500)); // adbd restarts in TCP mode
  const target = `${ip}:${port}`;

  let lastErr = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const { stdout } = await run(['connect', target], { timeout: 15000 });
      if (!/cannot|failed|unable/i.test(stdout)) return target;
      lastErr = stdout.trim();
    } catch (e) {
      lastErr = String(e.stdout || e.message || e).trim();
    }
    // A stale unauthenticated entry blocks re-auth — clear it before retrying
    await run(['disconnect', target]).catch(() => {});
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (/failed to authenticate/i.test(lastErr)) {
    throw new Error(
      `${target} refused the wireless connection. Put the headset on, accept the ` +
      '"Allow USB debugging" prompt (tick "Always allow from this computer"), then press Wi-Fi mode again.'
    );
  }
  throw new Error(lastErr || `Could not connect to ${target}.`);
}

async function connect(hostPort) {
  const { stdout } = await run(['connect', hostPort], { timeout: 15000 });
  if (/cannot|failed|unable/i.test(stdout)) throw new Error(stdout.trim());
  return stdout.trim();
}

async function disconnect(hostPort) {
  await run(['disconnect', hostPort]);
}

/** One PNG frame of the headset display. Returns a Buffer. */
function screenshot(serial) {
  return new Promise((resolve, reject) => {
    const proc = spawn(adbPath, ['-s', serial, 'exec-out', 'screencap', '-p'], { windowsHide: true });
    const chunks = [];
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('screenshot timeout'));
    }, 15000);
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      // Valid PNGs start with the 8-byte PNG signature
      if (code === 0 && buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) resolve(buf);
      else reject(new Error(`screencap failed (code ${code}, ${buf.length} bytes)`));
    });
  });
}

/**
 * `adb push` with progress. adb writes `[ 42%]` lines (carriage-returned) as
 * it transfers, which is the only progress signal available to us — the
 * install itself is opaque.
 */
function pushWithProgress(serial, localPath, remotePath, onProgress, timeout = 20 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(adbPath, ['-s', serial, 'push', localPath, remotePath], { windowsHide: true });
    let out = '';
    let last = -1;
    const timer = setTimeout(() => { proc.kill(); reject(new Error('push timed out')); }, timeout);

    const scan = (buf) => {
      out += buf;
      // adb repaints the same line with \r, so take the newest percentage seen
      const matches = String(buf).match(/\[\s*(\d{1,3})%\]/g);
      if (!matches || !onProgress) return;
      const pct = parseInt(matches[matches.length - 1].replace(/\D/g, ''), 10);
      if (pct !== last && pct >= 0 && pct <= 100) {
        last = pct;
        onProgress(pct);
      }
    };
    proc.stdout.on('data', scan);
    proc.stderr.on('data', scan);
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(out.trim().slice(0, 300) || `adb push exited ${code}`));
    });
  });
}

const REMOTE_STAGE_DIR = '/data/local/tmp';

/**
 * Install an APK, reporting upload progress.
 *
 * `adb install` streams the file itself and prints nothing useful while it
 * does, so the transfer is done as an explicit push (which does report
 * progress) and the install is run on the device against the staged file.
 * onProgress receives {phase: 'upload'|'install', pct}.
 */
async function installApk(serial, apkPath, onProgress = () => {}) {
  const remote = `${REMOTE_STAGE_DIR}/tobiya_${Date.now()}.apk`;
  try {
    onProgress({ phase: 'upload', pct: 0 });
    await pushWithProgress(serial, apkPath, remote, (pct) => onProgress({ phase: 'upload', pct }));
    onProgress({ phase: 'install', pct: 100 });

    const { stdout } = await shell(serial, `pm install -r -g "${remote}"`, { timeout: 300000 });
    if (!/Success/i.test(stdout)) throw new Error(stdout.trim() || 'install failed');
  } finally {
    // Never leave a 100+ MB APK sitting in the headset's tmp space
    await shell(serial, `rm -f "${remote}"`).catch(() => {});
  }
}

/** Installed third-party packages. */
async function listPackages(serial) {
  const { stdout } = await shell(serial, 'pm list packages -3', { timeout: 15000 });
  return stdout
    .split(/\r?\n/)
    .map((l) => l.replace(/^package:/, '').trim())
    .filter(Boolean)
    .sort();
}

/** Find a package's MAIN activity — VR apps register it under category INFO /
    com.oculus.intent.category.VR instead of LAUNCHER, so monkey can't see it. */
async function findMainActivity(serial, pkg) {
  try {
    const { stdout } = await shell(serial, `dumpsys package ${pkg}`, { timeout: 15000 });
    const idx = stdout.indexOf('android.intent.action.MAIN:');
    if (idx < 0) return null;
    const section = stdout.slice(idx, idx + 2500);
    const m = section.match(new RegExp(`${pkg.replace(/\./g, '\\.')}\\/(\\S+)`));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function launchPackage(serial, pkg) {
  // Fast path: monkey resolves the launcher activity for regular 2D apps
  try {
    const { stdout } = await shell(serial, `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, { timeout: 20000 });
    if (!/No activities found|monkey aborted/i.test(stdout)) return;
  } catch { /* no LAUNCHER activity — typical for VR-native apps */ }

  // VR path: start the MAIN activity directly by component name
  const activity = await findMainActivity(serial, pkg);
  if (!activity) throw new Error(`No launchable activity found in ${pkg}`);
  const { stdout } = await shell(serial, `am start -n ${pkg}/${activity}`, { timeout: 20000 });
  if (/Error:|Exception/i.test(stdout)) throw new Error(stdout.trim().slice(0, 300));
}

async function forceStop(serial, pkg) {
  await shell(serial, `am force-stop ${pkg}`);
}

async function keyevent(serial, code) {
  await shell(serial, `input keyevent ${code}`);
}

/** Package currently in the foreground (best effort). */
async function getForegroundPackage(serial) {
  try {
    const { stdout } = await shell(serial, 'dumpsys activity activities | grep -E "topResumedActivity|ResumedActivity" | head -2', { timeout: 10000 });
    const m = stdout.match(/u0\s+([\w.]+)\//);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** "Stop apps": force-stop the foreground third-party app and return Home. */
async function stopForegroundApp(serial) {
  const pkg = await getForegroundPackage(serial);
  const system = /^(com\.oculus\.|com\.meta\.|com\.android\.|android$|com\.pico|com\.pvr\.|com\.bytedance\.|com\.htc\.|com\.samsung\.)/;
  if (pkg && !system.test(pkg)) {
    await shell(serial, `am force-stop ${pkg}`).catch(() => {});
  }
  await keyevent(serial, 3);
  return pkg;
}

async function setBrightness(serial, value) {
  const v = Math.max(0, Math.min(255, Math.round(value)));
  await shell(serial, 'settings put system screen_brightness_mode 0');
  await shell(serial, `settings put system screen_brightness ${v}`);
}

async function setVolume(serial, value) {
  const v = Math.max(0, Math.min(15, Math.round(value)));
  try {
    await shell(serial, `cmd media_session volume --stream 3 --set ${v}`);
  } catch {
    await shell(serial, `media volume --stream 3 --set ${v}`);
  }
}

async function reboot(serial) {
  await run(['-s', serial, 'reboot'], { timeout: 10000 }).catch(() => {});
}

async function powerOff(serial) {
  await shell(serial, 'reboot -p', { timeout: 10000 }).catch(() => {});
}

const REMOTE_VIDEO_DIR = '/sdcard/Movies/FableVR';

async function pushVideo(serial, localPath, fileName, onProgress = () => {}) {
  await shell(serial, `mkdir -p ${REMOTE_VIDEO_DIR}`);
  const remote = `${REMOTE_VIDEO_DIR}/${fileName}`;
  // 360° files are the biggest thing this app moves — same progress treatment
  await pushWithProgress(serial, localPath, remote, (pct) => onProgress({ phase: 'upload', pct }));
  // Make the file visible to the headset's media library / VR video players
  await shell(serial, `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://${remote}`).catch(() => {});
  return remote;
}

async function listPushedVideos(serial) {
  try {
    const { stdout } = await shell(serial, `ls ${REMOTE_VIDEO_DIR}`, { timeout: 8000 });
    if (/No such file/i.test(stdout)) return [];
    return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Find the MediaStore content ID for a pushed video (modern Android players
    reject file:// URIs — Quest has NO handler for them at all). */
async function resolveVideoContentId(serial, fileName) {
  // _data reports /storage/emulated/0/… while we push to /sdcard/… — match the shared suffix
  const suffix = `Movies/FableVR/${fileName}`;
  try {
    const { stdout } = await shell(
      serial,
      `content query --uri content://media/external/video/media --projection _id:_data | grep '${suffix}'`,
      { timeout: 15000 }
    );
    const m = stdout.match(/_id=(\d+)/);
    return m ? m[1] : null;
  } catch {
    return null; // grep exits non-zero when the file is not indexed yet
  }
}

/** Quest ships a built-in 360°-capable player; targeting it explicitly avoids
    an "open with" chooser popping up inside the headset. */
const questPlayerCache = new Map(); // serial -> boolean
async function hasQuestPlayer(serial) {
  if (questPlayerCache.has(serial)) return questPlayerCache.get(serial);
  let has = false;
  try {
    const { stdout } = await shell(serial, 'pm list packages com.oculus.horizonmediaplayer', { timeout: 8000 });
    has = stdout.includes('com.oculus.horizonmediaplayer');
  } catch { /* treat as generic device */ }
  questPlayerCache.set(serial, has);
  return has;
}

async function startVideo(serial, fileName) {
  const remote = `${REMOTE_VIDEO_DIR}/${fileName}`;
  const ext = fileName.split('.').pop().toLowerCase();
  const mime = ext === 'mkv' ? 'video/x-matroska' : ext === 'webm' ? 'video/webm' : 'video/mp4';

  // 1. Resolve the file to a content:// URI, asking the media scanner if needed
  let id = await resolveVideoContentId(serial, fileName);
  if (!id) {
    await shell(serial, `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://${remote}`).catch(() => {});
    for (let i = 0; i < 3 && !id; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      id = await resolveVideoContentId(serial, fileName);
    }
  }

  if (id) {
    const uri = `content://media/external/video/media/${id}`;
    const base = `am start -a android.intent.action.VIEW -d ${uri} -t "${mime}" --grant-read-uri-permission`;
    const target = (await hasQuestPlayer(serial))
      ? ' -n com.oculus.horizonmediaplayer/.HorizonMediaPlayerActivity'
      : '';
    let { stdout } = await shell(serial, base + target, { timeout: 15000 });
    if (!/Error:|Exception/i.test(stdout)) return;
    if (target) {
      // player component renamed by an OS update? — retry letting Android pick
      ({ stdout } = await shell(serial, base, { timeout: 15000 }));
      if (!/Error:|Exception/i.test(stdout)) return;
    }
  }

  // 2. Last resort for older devices whose players still accept file:// URIs
  const { stdout } = await shell(
    serial,
    `am start -a android.intent.action.VIEW -d "file://${remote}" -t "${mime}"`,
    { timeout: 15000 }
  );
  if (/Error:|does not exist|unable to resolve/i.test(stdout)) {
    throw new Error(`No video player on this headset accepted the file. ${stdout.trim().slice(0, 200)}`);
  }
}

const REMOTE_RECORD_DIR = '/sdcard/FableVR/Recordings';

/** Start an on-device screenrecord in the background and hand back its remote
    PID. Backgrounding it (`&`) lets this short-lived adb shell call return
    immediately instead of blocking for the whole recording. */
async function startRecording(serial, { bitRate = 12000000, size = '' } = {}) {
  await shell(serial, `mkdir -p ${REMOTE_RECORD_DIR}`);
  const fileName = `rec_${Date.now()}.mp4`;
  const remote = `${REMOTE_RECORD_DIR}/${fileName}`;
  const sizeArg = size ? ` --size ${size}` : '';
  const cmd = `screenrecord --bit-rate ${bitRate}${sizeArg} ${remote} > /dev/null 2>&1 & echo REC_PID:$!`;
  const { stdout } = await shell(serial, cmd, { timeout: 10000 });
  const m = stdout.match(/REC_PID:(\d+)/);
  if (!m) throw new Error('screenrecord did not start on this headset.');
  return { remote, fileName, pid: m[1] };
}

/** Stop a background recording with SIGINT (kill -2) so screenrecord flushes
    and finalizes the MP4 container itself — a hard kill drops the closing
    moov atom and leaves an unplayable file. */
async function stopRecording(serial, pid) {
  await shell(serial, `kill -2 ${pid}`).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500)); // give the muxer a moment to finish writing
}

async function pullFile(serial, remotePath, localPath) {
  await run(['-s', serial, 'pull', remotePath, localPath], { timeout: 5 * 60 * 1000 });
}

async function deleteRemoteFile(serial, remotePath) {
  await shell(serial, `rm -f ${remotePath}`).catch(() => {});
}

module.exports = {
  restartServer,
  usbHeadsets,
  setAdbPath,
  getAdbPath,
  run,
  shell,
  listDevices,
  getBattery,
  getControllerBattery,
  getIp,
  enableWifiAdb,
  connect,
  disconnect,
  screenshot,
  installApk,
  pushWithProgress,
  listPackages,
  launchPackage,
  forceStop,
  keyevent,
  stopForegroundApp,
  setBrightness,
  setVolume,
  reboot,
  powerOff,
  pushVideo,
  listPushedVideos,
  startVideo,
  REMOTE_VIDEO_DIR,
  startRecording,
  stopRecording,
  pullFile,
  deleteRemoteFile,
  REMOTE_RECORD_DIR,
};
