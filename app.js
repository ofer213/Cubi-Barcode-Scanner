/* Cubey Scanner – phone app
 * Scans QR codes and barcodes with the phone camera.
 * Targets: PC (typed on a paired Cubey Scanner station), phone (copy to clipboard), list (Excel export).
 */
(() => {
  'use strict';

  const APP_VERSION = '1.3.0';
  const STORE = { settings: 'cubey.settings.v1', list: 'cubey.list.v1', history: 'cubey.history.v1' };
  const DEFAULTS = { target: 'phone', mode: 'continuous', beep: true, vibrate: true, wake: true, repeat: 1.5, sumQty: false, cameraId: '', ocrLang: 'heb+eng' };
  const HISTORY_MAX = 50;
  const READ_OPTS = {
    formats: [],               // all supported formats
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    tryDownscale: true,
    maxNumberOfSymbols: 4,
    returnErrors: true,        // damaged codes are reported (never typed)
    tryCode39ExtendedMode: true,
    eanAddOnSymbol: 'Read',    // EAN/UPC with 2/5-digit add-on (magazines, books)
  };
  // For dense/long barcodes: no internal downscaling, denoise, extra scan lines
  const READ_DENSE = Object.assign({}, READ_OPTS, { tryDownscale: false, tryDenoise: true });

  // Light bars on a dark background (laser-etched serials on consoles, e.g. PS5): turn the picture
  // into dark-on-light. zxing's own tryInvert does not cover 1D barcodes, so it is done here.
  function invertImage(image) {
    const d = image.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = 255 - d[i];
      d[i + 1] = 255 - d[i + 1];
      d[i + 2] = 255 - d[i + 2];
    }
    return image;
  }

  // Local contrast stretch: every area of the picture is spread to full black-to-white, so faint
  // bars (etched plastic, glare, shadow) become clear. Works on blocks with smooth blending.
  function stretchContrast(image, block = 64) {
    const { width: W, height: H, data: d } = image;
    const bx = Math.max(1, Math.ceil(W / block));
    const by = Math.max(1, Math.ceil(H / block));
    const lo = new Float32Array(bx * by);
    const hi = new Float32Array(bx * by);
    const hist = new Uint32Array(256);
    for (let j = 0; j < by; j += 1) {
      for (let i = 0; i < bx; i += 1) {
        hist.fill(0);
        const x0 = i * block, y0 = j * block;
        const x1 = Math.min(W, x0 + block), y1 = Math.min(H, y0 + block);
        let n = 0;
        for (let y = y0; y < y1; y += 2) {
          for (let x = x0; x < x1; x += 2) { hist[d[(y * W + x) * 4 + 1]] += 1; n += 1; }
        }
        let acc = 0, l = 0, h = 255;
        const nl = n * 0.02, nh = n * 0.98;
        for (let v = 0; v < 256; v += 1) {
          acc += hist[v];
          if (acc <= nl) l = v;
          if (acc < nh) h = v + 1;
        }
        lo[j * bx + i] = l;
        hi[j * bx + i] = Math.max(h, l + 1);
      }
    }
    for (let y = 0; y < H; y += 1) {
      const fy = Math.min(by - 1, Math.max(0, (y + 0.5) / block - 0.5));
      const j0 = Math.floor(fy), j1 = Math.min(by - 1, j0 + 1), ty = fy - j0;
      for (let x = 0; x < W; x += 1) {
        const fx = Math.min(bx - 1, Math.max(0, (x + 0.5) / block - 0.5));
        const i0 = Math.floor(fx), i1 = Math.min(bx - 1, i0 + 1), tx = fx - i0;
        const a = j0 * bx, b = j1 * bx;
        const l = (lo[a + i0] * (1 - tx) + lo[a + i1] * tx) * (1 - ty) + (lo[b + i0] * (1 - tx) + lo[b + i1] * tx) * ty;
        const h = (hi[a + i0] * (1 - tx) + hi[a + i1] * tx) * (1 - ty) + (hi[b + i0] * (1 - tx) + hi[b + i1] * tx) * ty;
        const o = (y * W + x) * 4;
        const span = h - l;
        const v = span < 16 ? 128 : ((d[o + 1] - l) * 255) / span;   // flat areas stay neutral grey
        d[o] = d[o + 1] = d[o + 2] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
    return image;
  }

  // ---------------------------------------------------------------- native detector (Android)
  const NATIVE_NAMES = {
    aztec: 'Aztec', code_128: 'Code128', code_39: 'Code39', code_93: 'Code93', codabar: 'Codabar',
    data_matrix: 'DataMatrix', ean_13: 'EAN13', ean_8: 'EAN8', itf: 'ITF', pdf417: 'PDF417',
    qr_code: 'QRCode', upc_a: 'UPCA', upc_e: 'UPCE',
  };
  let nativeDetector;          // undefined = not checked yet, null = not available
  async function getNativeDetector() {
    if (nativeDetector !== undefined) return nativeDetector;
    nativeDetector = null;
    try {
      if ('BarcodeDetector' in window) {
        const supported = await window.BarcodeDetector.getSupportedFormats();
        const formats = supported.filter((f) => NATIVE_NAMES[f]);
        if (formats.length) nativeDetector = new window.BarcodeDetector({ formats });
      }
    } catch (e) { nativeDetector = null; }
    return nativeDetector;
  }
  async function nativeDetect(source) {
    const det = await getNativeDetector();
    if (!det) return [];
    try {
      const found = await det.detect(source);
      return found
        .filter((b) => b.rawValue)
        .map((b) => ({ text: b.rawValue, format: NATIVE_NAMES[b.format] || b.format, isValid: true }));
    } catch (e) {
      return [];
    }
  }

  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- storage
  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
  }

  const settings = Object.assign({}, DEFAULTS, load(STORE.settings, {}));
  let list = load(STORE.list, []);
  let history = load(STORE.history, []);
  if (!Array.isArray(list)) list = [];
  if (!Array.isArray(history)) history = [];
  const saveSettings = () => save(STORE.settings, settings);
  const remote = new window.CubeyRemote.Remote();
  let pairMode = false;
  const saveList = () => save(STORE.list, list);
  const saveHistory = () => save(STORE.history, history);

  // ---------------------------------------------------------------- helpers
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function cleanText(text) {
    return String(text || '')
      .replace(/\r\n|\r|\n|\t/g, ' ')
      .replace(/[\u0000-\u001F\u007F]/g, '')
      .trim();
  }

  const pad = (n) => String(n).padStart(2, '0');
  function formatTime(ts) {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function formatDateTime(ts) {
    const d = new Date(ts);
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${formatTime(ts)}`;
  }
  function formatName(format) {
    if (format === 'TEXT') return 'טקסט מתמונה';
    return String(format || '').replace(/([a-z])([A-Z0-9])/g, '$1 $2');
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const child of [].concat(children)) if (child) node.appendChild(child);
    return node;
  }

  // ---------------------------------------------------------------- feedback
  let audioCtx = null;
  function ensureAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { audioCtx = null; }
  }
  function beep() {
    if (!settings.beep || !audioCtx) return;
    try {
      const t = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 1700;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.1);
    } catch (e) { /* ignore */ }
  }
  function vibrate() {
    if (settings.vibrate && navigator.vibrate) {
      try { navigator.vibrate(60); } catch (e) { /* ignore */ }
    }
  }
  function flash() {
    const f = $('flash');
    f.classList.add('on');
    setTimeout(() => f.classList.remove('on'), 120);
  }

  let toastTimer = null;
  function toast(message, ms = 1800) {
    const t = $('toast');
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  let hintTimer = null;
  function hint(message, ms = 3000) {
    const h = $('hint');
    h.textContent = message;
    h.hidden = false;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { h.hidden = true; }, ms);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fall through */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  // ---------------------------------------------------------------- decoder
  let zxingReady = null;
  // ---------------------------------------------------------------- camera
  let backCameras = [];
  const CAMERA_SIZE = { width: { ideal: 3840 }, height: { ideal: 2160 } };

  // Opens a camera: the chosen one (deviceId), otherwise the back camera. Asks for continuous
  // autofocus already when opening – some Android phones ignore it when it is only set afterwards.
  async function openCamera(deviceId) {
    const base = Object.assign({}, CAMERA_SIZE, { focusMode: { ideal: 'continuous' } });
    if (deviceId) {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: false, video: Object.assign({ deviceId: { exact: deviceId } }, base) });
      } catch (e) {
        if (settings.cameraId === deviceId) { settings.cameraId = ''; saveSettings(); }
      }
    }
    // as sharp as the camera allows (4K when available) – thin bars of long serial-number barcodes need it
    return navigator.mediaDevices.getUserMedia({ audio: false, video: Object.assign({ facingMode: { ideal: 'environment' } }, base) });
  }

  // Back cameras, main camera first ("camera2 0" / "camera 0" on Android is normally the main lens)
  async function listBackCameras() {
    try {
      const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      const front = /front|user|selfie|facetime|קדמית/i;
      let back = all.filter((d) => !front.test(d.label));
      if (!back.length) back = all;
      const num = (d) => { const m = /(\d+)\s*,/.exec(d.label || '') || /(\d+)\D*$/.exec(d.label || ''); return m ? Number(m[1]) : 99; };
      back.sort((a, b) => num(a) - num(b));
      backCameras = back;
    } catch (e) {
      backCameras = [];
    }
    return backCameras;
  }

  function prepareDecoder() {
    if (!zxingReady) {
      zxingReady = ZXingWASM.prepareZXingModule({
        overrides: {
          locateFile: (path, prefix) =>
            path.endsWith('.wasm') ? new URL('vendor/zxing_reader.wasm', document.baseURI).href : prefix + path,
        },
        fireImmediately: true,
      });
    }
    return zxingReady;
  }

  // ---------------------------------------------------------------- scanner
  const scanner = {
    stream: null,
    track: null,
    running: false,
    busy: false,
    timer: null,
    frameNo: 0,
    recent: new Map(),
    invalidStreak: 0,
    lastHint: 0,
    wakeLock: null,
    torchOn: false,
    canvas: null,
    ctx: null,

    async start() {
      ensureAudio();
      if (!window.isSecureContext) {
        setIdle('המצלמה פועלת רק בכתובת מאובטחת (https).');
        return;
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setIdle('הדפדפן הזה לא תומך במצלמה. נסה Chrome באנדרואיד או Safari באייפון.');
        return;
      }
      setScanButton('busy');
      try {
        await prepareDecoder();
      } catch (e) {
        console.error(e);
        setIdle('טעינת מנוע הסריקה נכשלה. בדוק חיבור לאינטרנט ונסה שוב.');
        setScanButton('idle');
        return;
      }

      let stream = null;
      try {
        stream = await openCamera(settings.cameraId);
      } catch (e) {
        if (e && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) {
          try { stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true }); } catch (e2) { e = e2; }
        }
        if (!stream) {
          const name = e && e.name;
          if (name === 'NotAllowedError' || name === 'SecurityError') {
            setIdle('אין הרשאה למצלמה. אפשר גישה למצלמה בהגדרות הדפדפן ולחץ שוב על "התחל סריקה".');
          } else if (name === 'NotReadableError') {
            setIdle('המצלמה תפוסה על ידי אפליקציה אחרת. סגור אותה ונסה שוב.');
          } else {
            setIdle('לא הצלחתי לפתוח את המצלמה.');
          }
          setScanButton('idle');
          return;
        }
      }

      this.stream = stream;
      const video = $('video');
      video.srcObject = stream;
      try { await video.play(); } catch (e) { /* autoplay with muted+playsinline normally works */ }

      this.track = stream.getVideoTracks()[0];
      // Some phones give a back camera without autofocus (wide-angle / depth lens) –
      // switch to the main back camera when that happens
      await listBackCameras();
      if (!this.hasAutofocus(this.track) && !settings.cameraId) await this.findAutofocusCamera(video);
      this.setupTrackFeatures();
      this.canvas = $('canvas');
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      this.recent.clear();
      this.invalidStreak = 0;
      this.running = true;
      $('camera').classList.add('live');
      $('cameraTools').hidden = false;
      setScanButton('running');
      await this.requestWakeLock();
      this.tick();
    },

    stop() {
      this.running = false;
      clearTimeout(this.timer);
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      this.track = null;
      this.torchOn = false;
      clearInterval(this.focusTimer);
      this.focusTimer = null;
      const video = $('video');
      video.srcObject = null;
      $('camera').classList.remove('live');
      $('cameraTools').hidden = true;
      $('btnTorch').setAttribute('aria-pressed', 'false');
      this.releaseWakeLock();
      setScanButton('idle');
    },

    setupTrackFeatures() {
      const track = this.track;
      let caps = {};
      try { caps = track.getCapabilities ? track.getCapabilities() : {}; } catch (e) { caps = {}; }

      this.caps = caps;
      this.setupFocus(track, caps);
      $('btnSwitchCam').hidden = backCameras.length < 2;

      const torchBtn = $('btnTorch');
      torchBtn.hidden = !caps.torch;
      torchBtn.setAttribute('aria-pressed', 'false');

      const zoomWrap = $('zoomWrap');
      const zoom = $('zoom');
      if (caps.zoom && caps.zoom.max > caps.zoom.min) {
        zoom.min = caps.zoom.min;
        zoom.max = Math.min(caps.zoom.max, caps.zoom.min * 8);
        zoom.step = caps.zoom.step || 0.1;
        let current = caps.zoom.min;
        try { current = track.getSettings().zoom || caps.zoom.min; } catch (e) { /* ignore */ }
        zoom.value = current;
        zoomWrap.hidden = false;
      } else {
        zoomWrap.hidden = true;
      }
    },

    hasAutofocus(track) {
      let caps = {};
      try { caps = track.getCapabilities ? track.getCapabilities() : {}; } catch (e) { return true; }
      // no focus information at all (iPhone/Safari, Firefox): the phone focuses by itself
      if (!caps || !Array.isArray(caps.focusMode) || !caps.focusMode.length) return true;
      return caps.focusMode.includes('continuous') || caps.focusMode.includes('single-shot');
    },

    async findAutofocusCamera(video) {
      const current = this.track && this.track.getSettings ? this.track.getSettings().deviceId : '';
      const others = backCameras.filter((c) => c.deviceId && c.deviceId !== current);
      if (!others.length) return;
      // many phones cannot open two cameras at once – close the current one first
      this.stream.getTracks().forEach((t) => t.stop());
      for (const cam of others) {
        let stream = null;
        try { stream = await openCamera(cam.deviceId); } catch (e) { continue; }
        const track = stream.getVideoTracks()[0];
        if (this.hasAutofocus(track)) {
          this.stream = stream;
          this.track = track;
          video.srcObject = stream;
          try { await video.play(); } catch (e) { /* ignore */ }
          return;
        }
        stream.getTracks().forEach((t) => t.stop());
      }
      // none has autofocus – back to the first camera
      const stream = await openCamera(current).catch(() => openCamera(''));
      this.stream = stream;
      this.track = stream.getVideoTracks()[0];
      video.srcObject = stream;
      try { await video.play(); } catch (e) { /* ignore */ }
    },

    // Autofocus: continuous when the camera supports it; otherwise single-shot focus repeated every
    // 2.5 s; a manual focus slider when the camera only has manual focus.
    setupFocus(track, caps) {
      clearInterval(this.focusTimer);
      this.focusTimer = null;
      const modes = Array.isArray(caps.focusMode) ? caps.focusMode : [];
      this.focusModes = modes;
      const focusWrap = $('focusWrap');
      focusWrap.hidden = true;
      if (modes.includes('continuous')) {
        track.applyConstraints({ focusMode: 'continuous' })
          .catch(() => track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }))
          .catch(() => {});
      } else if (modes.includes('single-shot')) {
        const shot = () => { if (this.track === track) track.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] }).catch(() => {}); };
        shot();
        this.focusTimer = setInterval(shot, 2500);
      } else if (modes.includes('manual') && caps.focusDistance && caps.focusDistance.max > caps.focusDistance.min) {
        const f = $('focus');
        f.min = caps.focusDistance.min;
        f.max = caps.focusDistance.max;
        f.step = caps.focusDistance.step || (caps.focusDistance.max - caps.focusDistance.min) / 100;
        let current = caps.focusDistance.min;
        try { current = track.getSettings().focusDistance || current; } catch (e) { /* ignore */ }
        f.value = current;
        focusWrap.hidden = false;
      }
      $('btnFocus').hidden = false;
    },

    // Tap on the picture / ⌖ button: focus again (on the tapped point when the camera supports it)
    async refocus(x, y) {
      const track = this.track;
      if (!track) return;
      const ring = $('focusRing');
      if (x !== undefined) {
        ring.style.left = `${x * 100}%`;
        ring.style.top = `${y * 100}%`;
      } else {
        ring.style.left = '50%';
        ring.style.top = '50%';
      }
      ring.classList.remove('on');
      void ring.offsetWidth;
      ring.classList.add('on');
      const modes = this.focusModes || [];
      const caps = this.caps || {};
      const point = x !== undefined && 'pointsOfInterest' in caps ? [{ x, y }] : null;
      try {
        if (modes.includes('single-shot')) {
          const c = { focusMode: 'single-shot' };
          if (point) c.pointsOfInterest = point;
          await track.applyConstraints({ advanced: [c] });
          if (modes.includes('continuous')) {
            setTimeout(() => {
              if (this.track === track) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
            }, 1500);
          }
        } else if (modes.includes('continuous')) {
          // switching the focus mode makes the lens search for focus again
          if (modes.includes('manual')) await track.applyConstraints({ advanced: [{ focusMode: 'manual' }] }).catch(() => {});
          const c = { focusMode: 'continuous' };
          if (point) c.pointsOfInterest = point;
          await track.applyConstraints({ advanced: [c] });
        }
      } catch (e) { /* ignore */ }
    },

    async setFocusDistance(value) {
      if (!this.track) return;
      try { await this.track.applyConstraints({ advanced: [{ focusMode: 'manual', focusDistance: Number(value) }] }); } catch (e) { /* ignore */ }
    },

    // Next back camera (phones with several lenses)
    async switchCamera() {
      await listBackCameras();
      if (backCameras.length < 2 || !this.track) return;
      const current = this.track.getSettings ? this.track.getSettings().deviceId : '';
      const i = backCameras.findIndex((c) => c.deviceId === current);
      const next = backCameras[(i + 1) % backCameras.length];
      let stream = null;
      try {
        this.stream.getTracks().forEach((t) => t.stop());
        stream = await openCamera(next.deviceId);
      } catch (e) {
        toast('לא ניתן לעבור למצלמה הזו');
        try { stream = await openCamera(''); } catch (e2) { this.stop(); return; }
      }
      settings.cameraId = next.deviceId;
      saveSettings();
      this.stream = stream;
      this.track = stream.getVideoTracks()[0];
      const video = $('video');
      video.srcObject = stream;
      try { await video.play(); } catch (e) { /* ignore */ }
      this.torchOn = false;
      $('btnTorch').setAttribute('aria-pressed', 'false');
      this.setupTrackFeatures();
      const n = backCameras.findIndex((c) => c.deviceId === next.deviceId) + 1;
      toast(`מצלמה אחורית ${n} מתוך ${backCameras.length}${this.hasAutofocus(this.track) ? '' : ' (ללא פוקוס אוטומטי)'}`);
    },

    async toggleTorch() {
      if (!this.track) return;
      const next = !this.torchOn;
      try {
        await this.track.applyConstraints({ advanced: [{ torch: next }] });
        this.torchOn = next;
        $('btnTorch').setAttribute('aria-pressed', String(next));
      } catch (e) {
        toast('לא ניתן להדליק את הפנס במכשיר הזה');
      }
    },

    async setZoom(value) {
      if (!this.track) return;
      try { await this.track.applyConstraints({ advanced: [{ zoom: Number(value) }] }); } catch (e) { /* ignore */ }
    },

    async requestWakeLock() {
      if (!settings.wake || !('wakeLock' in navigator)) return;
      try { this.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { this.wakeLock = null; }
    },
    releaseWakeLock() {
      if (this.wakeLock) {
        this.wakeLock.release().catch(() => {});
        this.wakeLock = null;
      }
    },

    tick() {
      if (!this.running) return;
      const video = $('video');
      if (!this.busy && video.readyState >= 2 && video.videoWidth > 0) {
        this.busy = true;
        this.decodeFrame(video)
          .then((result) => this.handleResult(result))
          .catch((e) => console.error(e))
          .finally(() => {
            this.busy = false;
            if (this.running) this.timer = setTimeout(() => this.tick(), 30);
          });
        return;
      }
      this.timer = setTimeout(() => this.tick(), 60);
    },

    async read(sx, sy, sw, sh, dw, dh, opts = READ_OPTS, invert = false, stretch = false) {
      const canvas = this.canvas;
      if (canvas.width !== dw) canvas.width = dw;
      if (canvas.height !== dh) canvas.height = dh;
      this.ctx.drawImage($('video'), sx, sy, sw, sh, 0, 0, dw, dh);
      const image = this.ctx.getImageData(0, 0, dw, dh);
      if (invert || stretch) {
        if (stretch) stretchContrast(image);
        if (invert) invertImage(image);
        this.ctx.putImageData(image, 0, 0);
      }
      return ZXingWASM.readBarcodes(image, opts);
    },

    async decodeFrame(video) {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      this.frameNo += 1;
      let invalid = false;
      const take = (results) => {
        const valid = results.filter((r) => r.isValid && r.text);
        if (!valid.length) invalid = invalid || results.some((r) => !r.isValid && r.text);
        return valid;
      };

      // Pass 0: the phone's built-in barcode engine (Chrome/Brave on Android) – fast and good with dense codes
      const native = await nativeDetect(video);
      if (native.length) return { valid: native, invalid: false };

      // Pass 1: whole picture (scaled to 1280 on the long side for speed)
      const scale = Math.min(1, 1280 / Math.max(vw, vh));
      let valid = take(await this.read(0, 0, vw, vh, Math.round(vw * scale), Math.round(vh * scale)));
      if (valid.length) return { valid, invalid: false };

      // Extra passes take turns, one per frame, so the camera stays smooth
      const turn = this.frameNo % 4;
      if (turn === 0) {
        // Center of the picture, enlarged – small barcodes
        const cw = Math.round(vw * 0.6);
        const ch = Math.round(vh * 0.6);
        const factor = Math.max(1, Math.min(2, 1100 / Math.max(cw, ch)));
        valid = take(await this.read(Math.round((vw - cw) / 2), Math.round((vh - ch) / 2), cw, ch,
          Math.round(cw * factor), Math.round(ch * factor)));
      } else if (turn === 1) {
        // Center of the picture at full camera resolution – long, dense barcodes (serial-number labels)
        const cw = Math.round(vw * 0.7);
        const ch = Math.round(vh * 0.7);
        valid = take(await this.read(Math.round((vw - cw) / 2), Math.round((vh - ch) / 2), cw, ch, cw, ch, READ_DENSE));
      } else if (turn === 3) {
        // Light bars on a dark background (PS5 and other consoles): inverted picture.
        // Whole picture first, then the center at full resolution for small, dense serials.
        const scale2 = Math.min(1, 1600 / Math.max(vw, vh));
        valid = take(await this.read(0, 0, vw, vh, Math.round(vw * scale2), Math.round(vh * scale2), READ_OPTS, true));
        if (!valid.length) {
          const native2 = await nativeDetect(this.canvas);
          if (native2.length) return { valid: native2, invalid: false };
          // center band, enlarged up to ×2 – tiny etched serials are only ~2 pixels per bar
          const cw = Math.round(vw * 0.7);
          const ch = Math.round(vh * 0.45);
          const factor = Math.max(1, Math.min(2, 2400 / Math.max(cw, ch)));
          valid = take(await this.read(Math.round((vw - cw) / 2), Math.round((vh - ch) / 2), cw, ch,
            Math.round(cw * factor), Math.round(ch * factor), READ_DENSE, true, true));
        }
      } else {
        // Wide band through the center (barcode lying down), then a tall band (barcode standing up),
        // at full resolution – enlarged when the camera picture is small
        const bands = [[0.85, 0.4], [0.4, 0.85]];
        for (const [fw, fh] of bands) {
          const cw = Math.round(vw * fw);
          const ch = Math.round(vh * fh);
          const factor = Math.max(1, Math.min(2, 1600 / Math.max(cw, ch)));
          valid = take(await this.read(Math.round((vw - cw) / 2), Math.round((vh - ch) / 2), cw, ch,
            Math.round(cw * factor), Math.round(ch * factor), READ_DENSE));
          if (valid.length) break;
        }
      }
      return { valid, invalid };
    },

    handleResult({ valid, invalid }) {
      const now = performance.now() / 1000;
      const fresh = [];
      for (const r of valid) {
        const text = cleanText(r.text);
        if (!text) continue;
        const last = this.recent.get(text);
        this.recent.set(text, now);
        if (last === undefined || now - last > Number(settings.repeat)) {
          if (!fresh.some((f) => f.text === text)) fresh.push({ text, format: r.format });
        }
      }
      for (const [text, seen] of this.recent) if (now - seen > 60) this.recent.delete(text);

      this.invalidStreak = valid.length ? 0 : (invalid ? this.invalidStreak + 1 : 0);
      if (this.invalidStreak >= 4 && now - this.lastHint > 3) {
        this.lastHint = now;
        hint('נמצא ברקוד, אבל הוא פגום או לא תקין – לא ניתן לקרוא אותו בוודאות');
      }

      for (const item of fresh) {
        onScan(item.text, item.format);
        if (settings.mode === 'single') {
          this.stop();
          break;
        }
      }
    },
  };

  // ---------------------------------------------------------------- scan handling
  function onScan(code, format) {
    beep();
    vibrate();
    flash();
    const isText = format === 'TEXT';
    // text from a photo: keeps its lines only when copied on the phone; one line for the PC / list
    const multiline = code;
    if (isText) code = cleanText(code).replace(/ {2,}/g, ' ').slice(0, 4000);

    // A station QR code pairs this phone, in any mode
    if (!isText && code.includes('#pair=')) {
      const station = remote.pair(code);
      if (station) {
        toast(`העמדה "${station.name}" חוברה ✓`, 2600);
        setTarget('pc');
        if (pairMode) {
          pairMode = false;
          scanner.stop();
        }
      } else {
        toast('קוד QR של עמדה לא תקין');
      }
      return;
    }
    if (pairMode) {
      toast('זה לא קוד חיבור. סרוק את קוד ה-QR שמוצג במחשב.');
      return;
    }

    if (settings.target === 'list') {
      list.push({ id: uid(), code, format, ts: Date.now() });
      saveList();
      renderList();
      const count = list.filter((x) => x.code === code).length;
      toast(count > 1 ? `נוסף לרשימה · ${code} (×${count})` : `נוסף לרשימה · ${code}`);
      return;
    }

    const entry = { id: uid(), code, format, ts: Date.now(), copied: false };
    history.unshift(entry);
    history = history.slice(0, HISTORY_MAX);
    saveHistory();

    if (settings.target === 'pc') {
      const station = remote.active;
      if (!station) {
        renderHistory();
        toast('קודם חבר עמדה: לחץ "חבר עמדה" וסרוק את הקוד שבמחשב', 3000);
        return;
      }
      entry.target = 'pc';
      entry.station = station.name;
      entry.state = 'sending';
      entry.msgId = remote.send(code, format);
      saveHistory();
      renderHistory();
      toast(`נשלח למחשב · ${code}`);
      return;
    }

    if (isText) entry.full = multiline;
    copyText(isText ? multiline : code).then((ok) => {
      entry.copied = ok;
      saveHistory();
      renderHistory();
      toast(ok ? `הועתק · ${code}` : `נסרק · הקש "העתק" כדי להעתיק`);
    });
    renderHistory();
  }

  // ---------------------------------------------------------------- rendering
  const ACK_TEXT = { type: 'הוקלד במחשב ✓', list: 'נוסף לרשימה במחשב ✓', both: 'הוקלד ונוסף לרשימה במחשב ✓' };
  function pcStateText(item) {
    const where = item.station ? `${item.station}: ` : '';
    if (item.state === 'sending') return `${where}ממתין לאישור מהמחשב…`;
    return where + (ACK_TEXT[item.state] || 'התקבל במחשב ✓');
  }

  function renderHistory() {
    const ul = $('history');
    ul.textContent = '';
    $('historyEmpty').hidden = history.length > 0;
    for (const item of history) {
      const copyBtn = el('button', {
        type: 'button',
        class: 'chip-btn ' + (item.copied ? 'copied' : 'copy'),
        text: item.copied ? 'הועתק ✓' : 'העתק',
        onclick: async () => {
          const ok = await copyText(item.full || item.code);
          item.copied = ok;
          saveHistory();
          renderHistory();
          toast(ok ? `הועתק · ${item.code}` : 'ההעתקה נכשלה');
        },
      });
      ul.appendChild(el('li', { class: 'item' }, [
        el('div', {}, [
          el('div', { class: 'code', text: item.code }),
          el('div', { class: 'meta', text: `${formatName(item.format)} · ${formatTime(item.ts)}` }),
          item.target === 'pc' ? el('div', { class: 'meta pc-state ' + (item.state || ''), text: pcStateText(item) }) : null,
        ]),
        el('div', { class: 'actions' }, [copyBtn]),
      ]));
    }
  }

  function groupList() {
    const groups = new Map();
    for (const item of list) {
      const g = groups.get(item.code);
      if (g) {
        g.qty += 1;
        g.last = Math.max(g.last, item.ts);
        g.first = Math.min(g.first, item.ts);
      } else {
        groups.set(item.code, { code: item.code, format: item.format, qty: 1, first: item.ts, last: item.ts });
      }
    }
    return [...groups.values()];
  }

  function renderList() {
    const ul = $('list');
    ul.textContent = '';
    const unique = new Set(list.map((x) => x.code)).size;
    $('listEmpty').hidden = list.length > 0;
    $('listSummary').textContent = list.length ? `· ${list.length} סריקות · ${unique} ברקודים` : '';
    $('btnExport').disabled = list.length === 0;
    $('btnShare').disabled = list.length === 0;
    const badge = $('listBadge');
    badge.hidden = list.length === 0;
    badge.textContent = String(list.length);

    if (settings.sumQty) {
      const groups = groupList().sort((a, b) => b.last - a.last);
      for (const g of groups) {
        ul.appendChild(el('li', { class: 'item' }, [
          el('div', {}, [
            el('div', { class: 'code', text: g.code }),
            el('div', { class: 'meta', text: `${formatName(g.format)} · אחרונה ${formatTime(g.last)}` }),
          ]),
          el('div', { class: 'actions' }, [
            el('button', { type: 'button', class: 'chip-btn', 'aria-label': 'הפחת', text: '−', onclick: () => changeQty(g.code, -1) }),
            el('span', { class: 'qty', text: String(g.qty) }),
            el('button', { type: 'button', class: 'chip-btn', 'aria-label': 'הוסף', text: '+', onclick: () => changeQty(g.code, 1) }),
          ]),
        ]));
      }
    } else {
      for (const item of [...list].reverse()) {
        ul.appendChild(el('li', { class: 'item' }, [
          el('div', {}, [
            el('div', { class: 'code', text: item.code }),
            el('div', { class: 'meta', text: `${formatName(item.format)} · ${formatDateTime(item.ts)}` }),
          ]),
          el('div', { class: 'actions' }, [
            el('button', { type: 'button', class: 'chip-btn', 'aria-label': 'מחק', text: '✕', onclick: () => removeItem(item.id) }),
          ]),
        ]));
      }
    }
  }

  function changeQty(code, delta) {
    if (delta > 0) {
      const sample = list.find((x) => x.code === code);
      list.push({ id: uid(), code, format: sample ? sample.format : '', ts: Date.now() });
    } else {
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (list[i].code === code) { list.splice(i, 1); break; }
      }
    }
    saveList();
    renderList();
  }

  function removeItem(id) {
    list = list.filter((x) => x.id !== id);
    saveList();
    renderList();
  }

  // ---------------------------------------------------------------- PC stations
  const CONN = {
    none: ['', ''],
    connecting: ['warn', 'מתחבר…'],
    'no-internet': ['bad', 'אין חיבור לאינטרנט – הסריקות יישלחו כשהחיבור יחזור'],
    'pc-offline': ['bad', 'המחשב לא זמין – התוכנה סגורה או שהמחשב כבוי. הסריקות יישלחו כשיחזור.'],
    relay: ['ok', 'מחובר · דרך האינטרנט'],
    direct: ['ok', 'מחובר · חיבור ישיר'],
    'direct-local': ['ok', 'מחובר · Wi-Fi ישיר'],
  };

  function renderStations() {
    const select = $('stationSelect');
    select.textContent = '';
    for (const st of remote.stations) {
      const opt = el('option', { value: st.id, text: st.name });
      if (st.id === remote.activeId) opt.selected = true;
      select.appendChild(opt);
    }
    const has = remote.stations.length > 0;
    $('stationBox').hidden = !has;
    $('pairHelp').hidden = has;
    renderConnection();
  }

  function renderConnection() {
    const [cls, text] = CONN[remote.state] || CONN.connecting;
    const box = $('connStatus');
    box.className = 'conn ' + cls;
    $('connText').textContent = text;
    const n = remote.pendingCount();
    $('pendingInfo').hidden = n === 0;
    $('pendingInfo').textContent = n ? `${n} סריקות ממתינות לשליחה` : '';
    $('btnClearPending').hidden = n === 0;
    const tabDot = $('pcDot');
    tabDot.className = 'tab-dot ' + (remote.active ? cls : '');
  }

  function startPairing() {
    setTarget('pc');
    pairMode = true;
    setIdle('סרוק את קוד ה-QR שמוצג במסך המחשב');
    toast('כוון את המצלמה לקוד ה-QR שבמחשב');
    if (!scanner.running) scanner.start();
  }

  // ---------------------------------------------------------------- Excel
  function excelSerial(ts) {
    const offsetMs = new Date(ts).getTimezoneOffset() * 60000;
    return (ts - offsetMs) / 86400000 + 25569;
  }

  function buildWorkbook() {
    let aoa;
    let cols;
    if (settings.sumQty) {
      const groups = groupList().sort((a, b) => a.first - b.first);
      aoa = [['ברקוד', 'כמות', 'סריקה אחרונה']].concat(groups.map((g) => [g.code, g.qty, g.last]));
      cols = [{ wch: 26 }, { wch: 8 }, { wch: 20 }];
    } else {
      aoa = [['ברקוד', 'תאריך ושעה']].concat(list.map((x) => [x.code, x.ts]));
      cols = [{ wch: 26 }, { wch: 20 }];
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const dateCol = settings.sumQty ? 2 : 1;
    for (let r = 1; r < aoa.length; r += 1) {
      const codeRef = XLSX.utils.encode_cell({ r, c: 0 });
      ws[codeRef] = { t: 's', v: String(aoa[r][0]) };        // keep long numbers exact (no 7.29E+12)
      const dateRef = XLSX.utils.encode_cell({ r, c: dateCol });
      ws[dateRef] = { t: 'n', v: excelSerial(aoa[r][dateCol]), z: 'dd/mm/yyyy hh:mm:ss' };
    }
    ws['!cols'] = cols;
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: cols.length - 1 } }) };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'סריקות');
    wb.Workbook = { Views: [{ RTL: true }] };
    return wb;
  }

  function fileName() {
    const d = new Date();
    return `cubey-scans-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}.xlsx`;
  }

  function exportExcel() {
    if (!list.length) return;
    try {
      XLSX.writeFile(buildWorkbook(), fileName(), { compression: true });
      toast('קובץ האקסל נשמר');
    } catch (e) {
      console.error(e);
      toast('שמירת הקובץ נכשלה');
    }
  }

  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  function canShareFiles() {
    try {
      return !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.xlsx', { type: XLSX_MIME })] }));
    } catch (e) {
      return false;
    }
  }

  async function shareExcel() {
    if (!list.length) return;
    try {
      const data = XLSX.write(buildWorkbook(), { bookType: 'xlsx', type: 'array', compression: true });
      const file = new File([data], fileName(), { type: XLSX_MIME });
      await navigator.share({ files: [file], title: 'Cubey Scanner – רשימת סריקות' });
    } catch (e) {
      if (e && e.name !== 'AbortError') toast('השיתוף נכשל');
    }
  }

  // ---------------------------------------------------------------- UI state
  function setIdle(message) {
    $('idleText').textContent = message;
  }

  function setScanButton(state) {
    const btn = $('btnScan');
    const text = $('btnScanText');
    btn.disabled = state === 'busy';
    btn.classList.toggle('stop', state === 'running');
    text.textContent = state === 'running' ? 'עצור סריקה' : state === 'busy' ? 'פותח מצלמה…' : 'התחל סריקה';
  }

  const IDLE_TEXT = {
    pc: 'הסריקה תוקלד במחשב, בשדה שבו נמצא הסמן.',
    phone: 'הסריקה תועתק ללוח ותופיע ברשימה למטה.',
    list: 'כל סריקה תתווסף לרשימה, ואפשר לשמור אותה כקובץ אקסל.',
  };

  function setTarget(target) {
    settings.target = target;
    saveSettings();
    for (const btn of document.querySelectorAll('.segmented [data-target]')) {
      btn.setAttribute('aria-selected', String(btn.dataset.target === target));
    }
    $('panelPc').hidden = target !== 'pc';
    $('copyHint').hidden = target === 'pc';
    remote.setEnabled(target === 'pc');
    $('panelPhone').hidden = target === 'list';
    $('panelList').hidden = target !== 'list';
    if (!scanner.running) setIdle(IDLE_TEXT[target]);
  }

  function setMode(mode) {
    settings.mode = mode;
    saveSettings();
    $('modeSingle').setAttribute('aria-checked', String(mode === 'single'));
    $('modeContinuous').setAttribute('aria-checked', String(mode === 'continuous'));
  }

  // ---------------------------------------------------------------- events
  function bind() {
    for (const btn of document.querySelectorAll('.segmented [data-target]')) {
      btn.addEventListener('click', () => setTarget(btn.dataset.target));
    }
    $('modeSingle').addEventListener('click', () => setMode('single'));
    $('modeContinuous').addEventListener('click', () => setMode('continuous'));

    $('btnScan').addEventListener('click', () => {
      if (scanner.running) {
        pairMode = false;
        scanner.stop();
      } else {
        scanner.start();
      }
    });
    $('btnTorch').addEventListener('click', () => scanner.toggleTorch());
    $('btnPhoto').addEventListener('click', () => { ensureAudio(); $('photoInput').click(); });
    $('photoInput').addEventListener('change', (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      scanPhotos(files);
    });
    $('zoom').addEventListener('input', (e) => scanner.setZoom(e.target.value));
    $('focus').addEventListener('input', (e) => scanner.setFocusDistance(e.target.value));
    $('btnFocus').addEventListener('click', () => scanner.refocus());
    $('btnSwitchCam').addEventListener('click', () => scanner.switchCamera());
    $('video').addEventListener('click', (e) => {
      if (!scanner.running) return;
      const r = e.currentTarget.getBoundingClientRect();
      scanner.refocus((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    });
    $('btnText').addEventListener('click', () => {
      ensureAudio();
      if (scanner.running) readTextFromCamera();
      else $('textInput').click();
    });
    $('textInput').addEventListener('change', (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      readTextFromPhotos(files);
    });

    $('sumQty').checked = !!settings.sumQty;
    $('sumQty').addEventListener('change', (e) => {
      settings.sumQty = e.target.checked;
      saveSettings();
      renderList();
    });
    $('btnClearList').addEventListener('click', () => {
      if (!list.length) return;
      if (window.confirm('למחוק את כל הרשימה?')) {
        list = [];
        saveList();
        renderList();
      }
    });
    $('btnClearHistory').addEventListener('click', () => {
      history = [];
      saveHistory();
      renderHistory();
    });
    $('btnExport').addEventListener('click', exportExcel);

    $('btnPair').addEventListener('click', startPairing);
    $('btnPairHelp').addEventListener('click', startPairing);
    $('stationSelect').addEventListener('change', (e) => remote.setActive(e.target.value));
    $('btnRemoveStation').addEventListener('click', () => {
      const st = remote.active;
      if (st && window.confirm(`להסיר את העמדה "${st.name}" מהטלפון?`)) remote.remove(st.id);
    });
    $('btnClearPending').addEventListener('click', () => {
      if (window.confirm('למחוק את הסריקות שעוד לא נשלחו למחשב?')) remote.clearPending();
    });
    remote.addEventListener('stations', renderStations);
    remote.addEventListener('status', renderConnection);
    remote.addEventListener('ack', (e) => {
      const item = history.find((h) => h.msgId === e.detail.id);
      if (item) {
        item.state = e.detail.result;
        saveHistory();
        renderHistory();
      }
    });
    $('btnShare').hidden = !canShareFiles();
    $('btnShare').addEventListener('click', shareExcel);

    // settings dialog
    const dialog = $('settingsDialog');
    $('btnSettings').addEventListener('click', () => {
      $('setBeep').checked = !!settings.beep;
      $('setVibrate').checked = !!settings.vibrate;
      $('setWake').checked = !!settings.wake;
      $('setRepeat').value = String(settings.repeat);
      $('setOcrLang').value = settings.ocrLang || 'heb+eng';
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    });
    $('setBeep').addEventListener('change', (e) => { settings.beep = e.target.checked; saveSettings(); if (settings.beep) { ensureAudio(); beep(); } });
    $('setVibrate').addEventListener('change', (e) => { settings.vibrate = e.target.checked; saveSettings(); });
    $('setWake').addEventListener('change', (e) => { settings.wake = e.target.checked; saveSettings(); });
    $('setRepeat').addEventListener('change', (e) => { settings.repeat = Number(e.target.value); saveSettings(); });
    $('setOcrLang').addEventListener('change', (e) => { settings.ocrLang = e.target.value; saveSettings(); });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && scanner.running) scanner.stop();
    });
  }

  // ---------------------------------------------------------------- start
  function init() {
    $('appVersion').textContent = APP_VERSION;
    bind();
    setupInstall();
    setMode(settings.mode === 'single' ? 'single' : 'continuous');
    setTarget(['pc', 'phone', 'list'].includes(settings.target) ? settings.target : 'phone');
    renderHistory();
    renderList();
    renderStations();
    if (location.hash.includes('#pair=')) {
      const station = remote.pair(location.hash);
      try { window.history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
      if (station) {
        setTarget('pc');
        toast(`העמדה "${station.name}" חוברה ✓`, 3000);
      }
    }
    prepareDecoder().catch(() => { /* retried on start */ });

    const local = ['localhost', '127.0.0.1'].includes(location.hostname);
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || local)) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  // ---------------------------------------------------------------- scan from a photo
  async function loadPhoto(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { /* fall back */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }

  // Reads every barcode in one photo: phone engine first, then zxing at several sizes
  async function decodePhoto(file) {
    const img = await loadPhoto(file);
    const W = img.width || img.naturalWidth;
    const H = img.height || img.naturalHeight;
    const found = new Map();
    const add = (list) => {
      for (const r of list) {
        const text = cleanText(r.text);
        if (r.isValid && text && !found.has(text)) found.set(text, r.format);
      }
    };
    let invalid = false;

    add(await nativeDetect(img));

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    // full size (up to 4000 px) first – thin bars stay sharp; then smaller – big/blurry codes
    const sizes = [4000, 2000, 1200].filter((s, i) => i === 0 || s < Math.max(W, H));
    for (const size of sizes) {
      const scale = Math.min(1, size / Math.max(W, H));
      canvas.width = Math.round(W * scale);
      canvas.height = Math.round(H * scale);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let results = await ZXingWASM.readBarcodes(image, READ_DENSE);
      add(results);
      invalid = invalid || results.some((r) => !r.isValid && r.text);
      if (found.size) break;
      // light bars on a dark background (PS5 and other consoles)
      results = await ZXingWASM.readBarcodes(invertImage(image), READ_DENSE);
      add(results);
      if (found.size) break;
      ctx.putImageData(image, 0, 0);
      add(await nativeDetect(canvas));
      if (found.size) break;
      // faint bars: local contrast stretch, dark-on-light and light-on-dark
      stretchContrast(image);
      add(await ZXingWASM.readBarcodes(image, READ_DENSE));
      if (found.size) break;
      add(await ZXingWASM.readBarcodes(invertImage(image), READ_DENSE));
      if (found.size) break;
    }
    if (img.close) img.close();
    return { codes: [...found].map(([text, format]) => ({ text, format })), invalid };
  }

  async function scanPhotos(files) {
    if (!files || !files.length) return;
    ensureAudio();
    const btn = $('btnPhoto');
    btn.disabled = true;
    $('btnPhotoText').textContent = 'קורא את התמונה…';
    if (scanner.running) scanner.stop();
    let total = 0;
    let damaged = false;
    try {
      await prepareDecoder();
      for (const file of files) {
        try {
          const { codes, invalid } = await decodePhoto(file);
          damaged = damaged || (invalid && !codes.length);
          for (const c of codes) {
            onScan(c.text, c.format);
            total += 1;
            if (codes.length > 1) await new Promise((r) => setTimeout(r, 350));
          }
        } catch (e) {
          console.error(e);
        }
      }
      if (!total) {
        toast(damaged ? 'נמצא ברקוד בתמונה, אבל הוא פגום ולא ניתן לקרוא אותו'
          : 'לא נמצא ברקוד בתמונה. צלם קרוב יותר, ישר וחד.', 3500);
      } else if (total > 1) {
        setTimeout(() => toast(`נקראו ${total} קודים מהתמונה`), 1900);
      }
    } catch (e) {
      console.error(e);
      toast('טעינת מנוע הסריקה נכשלה. בדוק חיבור לאינטרנט ונסה שוב.');
    } finally {
      btn.disabled = false;
      $('btnPhotoText').textContent = 'סרוק מתמונה';
    }
  }

  // ---------------------------------------------------------------- text from a photo (OCR)
  // Tesseract (Hebrew + English) runs on the phone itself; the engine (~7 MB) is downloaded on first use
  // and kept by the browser afterwards.
  const OCR_DIR = 'vendor/ocr/';
  let ocrWorker = null;
  let ocrWorkerLang = '';
  let ocrScript = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = src;
      tag.onload = resolve;
      tag.onerror = () => reject(new Error('load ' + src));
      document.head.appendChild(tag);
    });
  }

  async function getOcrWorker(progress) {
    const lang = settings.ocrLang || 'heb+eng';
    if (ocrWorker && ocrWorkerLang === lang) return ocrWorker;
    if (!ocrScript) ocrScript = loadScript(OCR_DIR + 'tesseract.min.js?v=' + APP_VERSION).catch((e) => { ocrScript = null; throw e; });
    await ocrScript;
    if (ocrWorker) { try { await ocrWorker.terminate(); } catch (e) { /* ignore */ } ocrWorker = null; }
    const dir = new URL(OCR_DIR, location.href).href;
    ocrWorker = await window.Tesseract.createWorker(lang.split('+'), 1 /* LSTM only */, {
      workerPath: dir + 'worker.min.js',
      corePath: dir,
      langPath: dir,
      workerBlobURL: false,
      gzip: true,
      logger: (m) => { if (progress && m && typeof m.progress === 'number') progress(m.status, m.progress); },
    });
    await ocrWorker.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300' });
    ocrWorkerLang = lang;
    return ocrWorker;
  }

  // Picture → canvas ready for OCR: gray, large enough (small text needs ~30 px letters),
  // dark-on-light (light text on a dark label is turned around), turned by `turn` quarter turns
  function ocrCanvas(source, W, H, turn = 0) {
    const scale = Math.min(2.5, Math.max(1, 1800 / Math.max(W, H)), 3200 / Math.max(W, H));
    const w = Math.round(W * scale);
    const h = Math.round(H * scale);
    const c = document.createElement('canvas');
    const side = turn % 2 === 1;
    c.width = side ? h : w;
    c.height = side ? w : h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(turn * Math.PI / 2);
    ctx.drawImage(source, -w / 2, -h / 2, w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
      d[i] = d[i + 1] = d[i + 2] = g;
      sum += g;
    }
    if (sum / (d.length / 4) < 100) invertImage(img);
    ctx.putImageData(img, 0, 0);
    return c;
  }

  // Lines with real words only – noise (random symbols from wood, fabric, shadows) is dropped
  function cleanOcr(data) {
    const lines = [];
    const blocks = (data && data.blocks) || [];
    for (const block of blocks) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          const count = (t) => (String(t || '').match(/[0-9A-Za-zא-ת]/g) || []).length;
          // short "words" are where noise shows up – they need a higher certainty
          const words = (line.words || []).filter((w) => {
            const n = count(w.text);
            return n >= 3 ? w.confidence >= 50 : n > 0 && w.confidence >= 80;
          });
          if (!words.length) continue;
          const avg = words.reduce((a, w) => a + w.confidence, 0) / words.length;
          const longWords = words.filter((w) => count(w.text) >= 3).length;
          const text = words.map((w) => w.text).join(' ').trim();
          if (avg >= 65 && longWords >= 1 && longWords * 2 >= words.length) lines.push(text);
        }
      }
    }
    if (!blocks.length && data && data.text && data.confidence >= 75) {
      for (const l of data.text.split('\n')) if (/[0-9A-Za-zא-ת]{2,}/.test(l)) lines.push(l.trim());
    }
    // direction marks that Tesseract adds around English inside Hebrew – invisible, but they would be typed
    return lines.join('\n').replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '').trim();
  }

  async function ocrOne(source, W, H, progress) {
    const worker = await getOcrWorker(progress);
    let best = { text: '', score: 0 };
    // upright first; the other directions only when little was read (photo taken sideways / upside down)
    for (const turn of [0, 1, 3, 2]) {
      const canvas = ocrCanvas(source, W, H, turn);
      const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true });
      const text = cleanOcr(data);
      const letters = (text.match(/[0-9A-Za-zא-ת]/g) || []).length;
      const score = letters * (data.confidence || 0);
      if (score > best.score) best = { text, score, conf: data.confidence || 0 };
      if (best.conf >= 75 && letters >= 4) break;
    }
    // a single short word read with low certainty is almost always noise
    const letters = (best.text.match(/[0-9A-Za-z\u05D0-\u05EA]/g) || []).length;
    if (letters < 5 && (best.conf || 0) < 80) return '';
    return best.text;
  }

  function ocrBusy(on, label) {
    const btn = $('btnText');
    btn.disabled = on;
    $('btnTextText').textContent = on ? (label || 'מזהה טקסט…') : 'טקסט מתמונה';
  }
  const ocrProgress = (status, p) => {
    if (/load|initializ/i.test(status) && p < 1) ocrBusy(true, 'טוען מנוע טקסט…');
    else if (/recogniz/i.test(status)) ocrBusy(true, `מזהה טקסט… ${Math.round(p * 100)}%`);
  };

  function deliverText(text) {
    if (!text) {
      toast('לא זוהה טקסט ברור. צלם קרוב יותר, ישר, עם תאורה טובה.', 3500);
      return false;
    }
    onScan(text, 'TEXT');
    return true;
  }

  async function readTextFromPhotos(files) {
    if (!files || !files.length) return;
    if (scanner.running) scanner.stop();
    ocrBusy(true);
    try {
      for (const file of files) {
        const img = await loadPhoto(file);
        const text = await ocrOne(img, img.width || img.naturalWidth, img.height || img.naturalHeight, ocrProgress);
        if (img.close) img.close();
        deliverText(text);
      }
    } catch (e) {
      console.error(e);
      toast('טעינת מנוע הטקסט נכשלה. בדוק חיבור לאינטרנט ונסה שוב.', 3500);
    } finally {
      ocrBusy(false);
    }
  }

  // Camera is on: read the text from the current picture (full camera resolution)
  async function readTextFromCamera() {
    const video = $('video');
    if (!video.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    flash();
    if (settings.mode === 'single') scanner.stop();
    ocrBusy(true);
    try {
      deliverText(await ocrOne(c, c.width, c.height, ocrProgress));
    } catch (e) {
      console.error(e);
      toast('טעינת מנוע הטקסט נכשלה. בדוק חיבור לאינטרנט ונסה שוב.', 3500);
    } finally {
      ocrBusy(false);
    }
  }

  // ---------------------------------------------------------------- home-screen icon
  let installEvent = null;
  function isInstalled() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  }
  function setupInstall() {
    const btn = $('btnInstall');
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const mobile = ios || /android/i.test(navigator.userAgent);
    btn.hidden = isInstalled() || !mobile;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      installEvent = e;
      btn.hidden = isInstalled();
    });
    window.addEventListener('appinstalled', () => {
      installEvent = null;
      btn.hidden = true;
      toast('האייקון נוסף למסך הבית ✓', 2600);
    });
    btn.addEventListener('click', async () => {
      if (installEvent) {
        installEvent.prompt();
        try { await installEvent.userChoice; } catch (e) { /* ignore */ }
        installEvent = null;
        return;
      }
      $('installIos').hidden = !ios;
      $('installAndroid').hidden = ios;
      const d = $('installDialog');
      if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
    });
  }

  // test hook (used by automated tests only)
  window.__cubey = { scanner, onScan, scanPhotos, buildWorkbook, remote, get list() { return list; }, get history() { return history; }, settings };

  init();
})();
