/**
 * Real-time casting — one persistent H.264 stream per headset.
 * Uses `adb exec-out screenrecord --output-format=h264 -` (the device's own
 * hardware encoder, same technique scrcpy uses) and pipes the raw stream to
 * the renderer, where WebCodecs hardware-decodes it into the live grid.
 *
 * screenrecord hard-stops at 3 minutes, so each stream is a segment loop:
 * when a segment ends we immediately start the next one; the decoder
 * re-syncs on the new segment's SPS/IDR within a frame or two.
 *
 * A headset has exactly one encoder, so there is exactly one stream per
 * serial no matter how many windows want it. Windows subscribe to that
 * stream instead of each spawning their own — the Settings preview and the
 * Live Stream window can show the same headset at once, and the device is
 * only released when the last subscriber leaves.
 */
const { spawn } = require('child_process');
const adb = require('./adb');

const active = new Map(); // serial -> {proc, stopped, retried, scaled, subs:Set<webContents>}

function isCasting(serial) {
  return active.has(serial);
}

/** Fan a message out to every live subscriber, dropping destroyed windows. */
function broadcast(entry, channel, ...args) {
  for (const wc of [...entry.subs]) {
    if (wc.isDestroyed()) entry.subs.delete(wc);
    else wc.send(channel, ...args);
  }
}

/**
 * Subscribe `wc` to this headset's stream, starting it if nobody had it yet.
 * Returns true when this call actually spawned the stream.
 */
function start(serial, wc, opts = {}) {
  const existing = active.get(serial);
  if (existing) {
    existing.subs.add(wc); // already running — just listen in
    return false;
  }

  const entry = { proc: null, stopped: false, retried: false, scaled: !!opts.size, subs: new Set([wc]) };
  active.set(serial, entry);

  const spawnSegment = () => {
    if (entry.stopped) return;
    const args = [
      '-s', serial, 'exec-out', 'screenrecord',
      '--output-format=h264',
      '--bit-rate', String(opts.bitRate || 4000000),
      '--time-limit', '179',
    ];
    if (opts.size) args.push('--size', opts.size);
    args.push('-');

    const proc = spawn(adb.getAdbPath(), args, { windowsHide: true });
    entry.proc = proc;
    const startedAt = Date.now();
    let gotData = false;
    let stderrBuf = '';

    proc.stdout.on('data', (chunk) => {
      gotData = true;
      if (!entry.stopped) broadcast(entry, 'cast:data', serial, chunk);
    });
    proc.stderr.on('data', (d) => { stderrBuf += String(d); });
    proc.on('error', (e) => { stderrBuf += String(e); });
    proc.on('close', () => {
      if (entry.stopped) return;
      // Died instantly with no video = device dozing, encoder busy, or unsupported.
      const quickFail = !gotData || Date.now() - startedAt < 2000;
      if (quickFail) {
        if (!entry.retried) {
          // One retry: clear any stale on-device screenrecord holding the
          // encoder, give a dozing headset a moment, then try again.
          entry.retried = true;
          adb.shell(serial, 'pkill -2 screenrecord', { timeout: 5000 }).catch(() => {});
          adb.keyevent(serial, 224).catch(() => {}); // WAKEUP
          setTimeout(spawnSegment, 2000);
          return;
        }
        active.delete(serial);
        broadcast(entry, 'cast:event', serial, 'error',
          (stderrBuf.trim() || 'screenrecord produced no video on this device').slice(0, 300));
      } else {
        entry.retried = false; // healthy segment restores the retry budget
        broadcast(entry, 'cast:event', serial, 'restart', '');
        spawnSegment(); // seamless next segment (3-minute screenrecord limit)
      }
    });
  };

  // An abrupt earlier stop can leave screenrecord running on the device and
  // holding the encoder — clear it before the first segment.
  adb.shell(serial, 'pkill -2 screenrecord', { timeout: 5000 })
    .catch(() => {})
    .then(() => setTimeout(spawnSegment, 250));

  return true;
}

/**
 * Unsubscribe `wc`. The device keeps streaming while anyone else is watching;
 * omitting `wc` tears the stream down regardless (app shutdown).
 */
function stop(serial, wc) {
  const entry = active.get(serial);
  if (!entry) return;

  if (wc) {
    entry.subs.delete(wc);
    if (entry.subs.size) return; // somebody else is still watching
  }

  entry.stopped = true;
  try { entry.proc?.kill(); } catch { /* already gone */ }
  // Killing the local adb pipe does not stop screenrecord on the device —
  // end it explicitly so it doesn't block the next cast.
  adb.shell(serial, 'pkill -2 screenrecord', { timeout: 5000 }).catch(() => {});
  active.delete(serial);
}

/** Drop one window's subscriptions, or every stream when called bare. */
function stopAll(wc) {
  for (const serial of [...active.keys()]) stop(serial, wc);
}

/** Re-spawn a stream at new options, keeping its existing subscribers. */
function restart(serial, opts = {}) {
  const entry = active.get(serial);
  if (!entry) return false;
  const subs = [...entry.subs];
  stop(serial);
  for (const wc of subs) {
    if (!wc.isDestroyed()) start(serial, wc, opts);
  }
  return true;
}

function isScaled(serial) {
  return !!active.get(serial)?.scaled;
}

/** How many windows are watching a serial (0 when it is not casting). */
function subscriberCount(serial) {
  return active.get(serial)?.subs.size || 0;
}

module.exports = { start, stop, stopAll, restart, isCasting, isScaled, subscriberCount };
