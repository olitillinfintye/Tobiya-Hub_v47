/* Tobiya Hub — shared live-cast decoder.
   Turns the raw H.264 Annex-B bytes that src/caster.js pipes over `cast:data`
   into painted canvas frames. Loaded by both the Live Stream window and the
   Settings preview so there is one decoder implementation, not two.

   Everything view-specific (which eye to crop, how far to counter-rotate,
   what to do when the stream goes live or dies) arrives as hooks, because
   the wall and the Settings card answer those differently. */

/** Paint one eye of a capture, tilt-corrected, with a UNIFORM scale only — the
    picture is never stretched on one axis, so the headset's own lens warp is
    left exactly as captured.
      opts.fit  'fill' (default) — scale until the tile is covered edge-to-edge
                and crop the overflow; 'fit' — whole eye visible, letterboxed.
      opts.trim 0…0.3 — fraction shaved off every edge of the eye first, to
                hide the black lens border around immersive frames. */
function drawEyeFrame(canvas, source, sx, sw, sh, tiltDeg, opts = {}) {
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.max(2, Math.round((canvas.clientWidth || 640) * dpr));
  const ch = Math.max(2, Math.round((canvas.clientHeight || 360) * dpr));
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cw, ch);

  const trim = Math.max(0, Math.min(0.3, Number(opts.trim) || 0));
  const tx = sw * trim;
  const ty = sh * trim;
  const srcX = sx + tx;
  const srcY = ty;
  const srcW = Math.max(2, sw - 2 * tx);
  const srcH = Math.max(2, sh - 2 * ty);

  const th = (tiltDeg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(th));
  const sin = Math.abs(Math.sin(th));
  let s;

  if (opts.fit === 'fit') {
    // contain: the whole eye fits the tile at its native aspect ratio
    const base = Math.min(cw / srcW, ch / srcH);
    const dw = srcW * base;
    const dh = srcH * base;
    // clip to the eye's box so a tilt-corrected frame can't spill outside it
    ctx.beginPath();
    ctx.rect((cw - dw) / 2, (ch - dh) / 2, dw, dh);
    ctx.clip();
    // small uniform zoom so the rotated image still fills its box (no corners)
    const cover = Math.max((dw * cos + dh * sin) / dw, (dw * sin + dh * cos) / dh);
    s = base * cover;
  } else {
    // fill: smallest uniform scale at which the (rotated) eye covers the tile
    s = Math.max((cw * cos + ch * sin) / srcW, (cw * sin + ch * cos) / srcH);
  }

  ctx.translate(cw / 2, ch / 2);
  ctx.rotate(th);
  ctx.drawImage(source, srcX, srcY, srcW, srcH, (-srcW * s) / 2, (-srcH * s) / 2, srcW * s, srcH * s);
  ctx.restore();
}

/** Read width/height straight out of an SPS NAL, so the capture size is known
    before a single frame has been decoded. */
function parseSpsDimensions(nal) {
  try {
    const off = (nal[2] === 1 ? 3 : 4) + 1;
    const rbsp = [];
    for (let i = off; i < nal.length; i++) {
      if (i > off + 1 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
      rbsp.push(nal[i]);
    }
    let bit = 0;
    const u = (n) => {
      let v = 0;
      for (let i = 0; i < n; i++) { v = (v << 1) | ((rbsp[bit >> 3] >> (7 - (bit & 7))) & 1); bit++; }
      return v;
    };
    const ue = () => {
      let zeros = 0;
      while (u(1) === 0 && zeros < 32) zeros++;
      return zeros ? (1 << zeros) - 1 + u(zeros) : 0;
    };
    const se = () => { const k = ue(); return k & 1 ? (k + 1) / 2 : -k / 2; };
    const profile = u(8);
    u(8); u(8); ue();
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      const chroma = ue();
      if (chroma === 3) u(1);
      ue(); ue(); u(1);
      if (u(1)) {
        const lists = chroma === 3 ? 12 : 8;
        for (let i = 0; i < lists; i++) {
          if (u(1)) {
            const size = i < 6 ? 16 : 64;
            let last = 8, next = 8;
            for (let j = 0; j < size; j++) {
              if (next !== 0) next = (last + se() + 256) % 256;
              last = next === 0 ? last : next;
            }
          }
        }
      }
    }
    ue();
    const poc = ue();
    if (poc === 0) ue();
    else if (poc === 1) { u(1); se(); se(); const n = ue(); for (let i = 0; i < n; i++) se(); }
    ue(); u(1);
    const widthMbs = ue() + 1;
    const heightMapUnits = ue() + 1;
    const frameMbsOnly = u(1);
    if (!frameMbsOnly) u(1);
    u(1);
    let cl = 0, cr = 0, ct = 0, cb = 0;
    if (u(1)) { cl = ue(); cr = ue(); ct = ue(); cb = ue(); }
    const width = widthMbs * 16 - (cl + cr) * 2;
    const height = (2 - frameMbsOnly) * heightMapUnits * 16 - (ct + cb) * 2;
    return width > 0 && height > 0 && width < 16384 && height < 16384 ? { width, height } : null;
  } catch {
    return null;
  }
}

/**
 * Decides whether a capture is side-by-side stereo (both eyes on one frame)
 * or already a single view. Headsets differ: Quest 2/3 screenrecord grabs the
 * full stereo swapchain, while Pico/Vive (and Quest home or 2D panel apps)
 * hand over one eye already — blindly half-cropping those chops the only eye
 * in half. Aspect-ratio guesses failed too (Quest 2's stereo capture is
 * ~16:9), so this compares the actual content: the two halves of a stereo
 * frame are the same scene shifted by eye parallax, a mono frame's are not.
 */
class StereoDetector {
  constructor() {
    this.w = 64; // tiny luma grid — downscaling blurs away parallax detail
    this.h = 32;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.ctx = this.canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    this.stereo = true; // crop by default — immersive VR is the common case
    this.votes = 0;     // consecutive samples contradicting the current verdict
    this.nextAt = 0;    // sampling is throttled; layout doesn't change per frame
  }

  /**
   * One-shot measurement: true = side-by-side stereo, false = single view,
   * null = frame too flat/ambiguous to tell (loading screens, fades).
   */
  measure(source, sw, sh) {
    let data;
    try {
      this.ctx.drawImage(source, 0, 0, sw, sh, 0, 0, this.w, this.h);
      data = this.ctx.getImageData(0, 0, this.w, this.h).data;
    } catch {
      return null;
    }
    const { w, h } = this;
    const half = w / 2;
    const luma = new Float32Array(w * h);
    let mean = 0;
    for (let i = 0; i < luma.length; i++) {
      const p = i * 4;
      luma[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      mean += luma[i];
    }
    mean /= luma.length;
    // Mean absolute deviation = how much contrast the frame has at all.
    let mad = 0;
    for (let i = 0; i < luma.length; i++) mad += Math.abs(luma[i] - mean);
    mad /= luma.length;
    // A near-flat frame (black, solid loading screen) says nothing about layout.
    if (mad < 4) return null;

    // Best half-vs-half match over small horizontal shifts absorbs the
    // remaining eye parallax that downscaling didn't.
    let best = Infinity;
    for (let shift = -4; shift <= 4; shift++) {
      let diff = 0;
      let n = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 4; x < half - 4; x++) {
          diff += Math.abs(luma[y * w + x] - luma[y * w + half + x + shift]);
          n++;
        }
      }
      best = Math.min(best, diff / n);
    }
    // Normalising by the frame's own contrast makes the verdict independent
    // of how bright or busy the scene is: stereo halves land well under 0.35,
    // unrelated halves well over 0.7; the gap between is "no vote".
    const ratio = best / mad;
    return ratio < 0.35 ? true : ratio > 0.7 ? false : null;
  }

  /**
   * Feed the latest frame; returns the smoothed verdict. Throttled, and a
   * verdict only flips after two consecutive contradicting samples so a
   * single odd frame can't make the view jump between full and half width.
   */
  sample(source, sw, sh) {
    const now = performance.now();
    if (now < this.nextAt) return this.stereo;
    this.nextAt = now + 500;
    const verdict = this.measure(source, sw, sh);
    if (verdict === null || verdict === this.stereo) {
      this.votes = 0;
    } else if (++this.votes >= 2) {
      this.stereo = verdict;
      this.votes = 0;
    }
    return this.stereo;
  }
}

const AUTO_SCALE_PX = 2000000; // above this the main process re-starts at half size

/**
 * One decoder per casting headset.
 *
 * hooks:
 *   crop(w, h, stereo) -> {sx, sw}  which slice of the frame to paint;
 *                `stereo` is the detector's verdict on this stream (true =
 *                side-by-side capture, false = already a single view)
 *   tilt(serial) -> degrees   counter-rotation for rotated panels
 *   onLive()                  first painted frame
 *   onError(msg)              stream is dead
 *   onStat(kind)              optional counter ('decoded' | 'painted')
 */
class CastPlayer {
  constructor(serial, canvas, hooks = {}) {
    this.serial = serial;
    this.canvas = canvas;
    this.hooks = hooks;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.buf = new Uint8Array(0);
    this.sps = null;
    this.pps = null;
    this.decoder = null;
    this.needConfig = true;
    this.ts = 0;
    this.dead = false;
    this.latest = null;
    this.rafPending = false;
    this.skipUntilKey = false;
    this.reported = false;
    this.holdForRestart = false;
    this.liveShown = false;
    this.stereoDet = new StereoDetector();
  }

  feed(data) {
    if (this.dead) return;
    const m = new Uint8Array(this.buf.length + data.length);
    m.set(this.buf);
    m.set(data, this.buf.length);
    const starts = [];
    for (let i = 0; i + 2 < m.length; i++) {
      if (m[i] === 0 && m[i + 1] === 0) {
        if (m[i + 2] === 1) { starts.push(i); i += 2; }
        else if (m[i + 2] === 0 && i + 3 < m.length && m[i + 3] === 1) { starts.push(i); i += 3; }
      }
    }
    if (starts.length < 2) { this.buf = m; return; }
    for (let k = 0; k < starts.length - 1; k++) {
      this.handleNal(m.subarray(starts[k], starts[k + 1]));
    }
    this.buf = m.slice(starts[starts.length - 1]);
  }

  handleNal(nal) {
    const scLen = nal[2] === 1 ? 3 : 4;
    const type = nal[scLen] & 0x1f;
    if (type === 7) {
      this.sps = nal.slice();
      this.needConfig = true;
      if (!this.reported) {
        this.reported = true;
        const dims = parseSpsDimensions(this.sps);
        if (dims) {
          this.hooks.onSize?.(dims.width, dims.height);
          // Hold frames until main says whether it is restarting this stream
          // at half size — otherwise we paint a frame that is about to be
          // thrown away.
          if (dims.width * dims.height > AUTO_SCALE_PX) this.holdForRestart = true;
          window.vr.reportCastSize({ serial: this.serial, width: dims.width, height: dims.height })
            .then((r) => { if (!r?.restarted) this.holdForRestart = false; })
            .catch(() => { this.holdForRestart = false; });
        }
      }
    } else if (type === 8) {
      this.pps = nal.slice();
    } else if (type === 5) {
      if (this.holdForRestart) return;
      if (!this.sps || !this.pps) return;
      if (this.needConfig) this.configure();
      if (this.decoder?.state !== 'configured') return;
      this.skipUntilKey = false;
      const chunk = new Uint8Array(this.sps.length + this.pps.length + nal.length);
      chunk.set(this.sps);
      chunk.set(this.pps, this.sps.length);
      chunk.set(nal, this.sps.length + this.pps.length);
      this.decode(chunk, 'key');
    } else if (type === 1) {
      if (this.holdForRestart || this.skipUntilKey) return;
      if (this.decoder?.state === 'configured' && !this.needConfig) this.decode(nal, 'delta');
    }
  }

  configure() {
    const off = (this.sps[2] === 1 ? 3 : 4) + 1;
    const codec = 'avc1.' +
      [this.sps[off], this.sps[off + 1], this.sps[off + 2]]
        .map((b) => b.toString(16).padStart(2, '0')).join('');
    try { this.decoder?.close(); } catch { /* fresh start */ }
    this.decoder = new VideoDecoder({
      output: (frame) => this.paint(frame),
      error: (e) => this.fail(String(e?.message || e)),
    });
    try {
      this.decoder.configure({ codec, optimizeForLatency: true });
      this.needConfig = false;
    } catch (e) {
      this.fail(String(e?.message || e));
    }
  }

  decode(bytes, type) {
    this.ts += 33333;
    try {
      this.decoder.decode(new EncodedVideoChunk({ type, timestamp: this.ts, data: bytes }));
      this.hooks.onStat?.('decoded');
      if (this.decoder.decodeQueueSize > 16) this.skipUntilKey = true;
    } catch (e) {
      this.fail(String(e?.message || e));
    }
  }

  paint(frame) {
    if (this.dead) { frame.close(); return; }
    if (this.latest) this.latest.close();
    this.latest = frame;
    if (!this.rafPending) {
      this.rafPending = true;
      requestAnimationFrame(() => this.renderLatest());
    }
  }

  renderLatest() {
    this.rafPending = false;
    const frame = this.latest;
    if (!frame || this.dead) return;
    this.latest = null;
    const dw = frame.displayWidth;
    const dh = frame.displayHeight;
    this.hooks.onSize?.(dw, dh);
    const stereo = this.stereoDet.sample(frame, dw, dh);
    const { sx, sw } = this.hooks.crop ? this.hooks.crop(dw, dh, stereo) : { sx: 0, sw: dw };
    drawEyeFrame(this.canvas, frame, sx, sw, dh, this.hooks.tilt ? this.hooks.tilt(this.serial) : 0,
      this.hooks.view ? this.hooks.view(stereo) : {});
    this.hooks.onStat?.('painted');
    if (!this.liveShown) {
      this.liveShown = true;
      this.hooks.onLive?.();
    }
    frame.close();
  }

  resync() {
    this.buf = new Uint8Array(0);
    this.needConfig = true;
    this.holdForRestart = false;
  }

  fail(msg) {
    if (this.dead) return;
    this.dead = true;
    this.hooks.onError?.(msg);
  }

  destroy() {
    this.dead = true;
    if (this.latest) { try { this.latest.close(); } catch { /* closed */ } this.latest = null; }
    try { this.decoder?.close(); } catch { /* closed */ }
  }
}

window.CastPlayer = CastPlayer;
window.StereoDetector = StereoDetector;
window.drawEyeFrame = drawEyeFrame;
window.parseSpsDimensions = parseSpsDimensions;
