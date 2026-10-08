/* Cubey Scanner – phone app
 * Scans QR codes and barcodes with the phone camera.
 * Targets: PC (enabled by the next Cubey Scanner update), phone (copy to clipboard), list (Excel export).
 */
(() => {
  'use strict';

  const APP_VERSION = '1.0.0';
  const STORE = { settings: 'cubey.settings.v1', list: 'cubey.list.v1', history: 'cubey.history.v1' };
  const DEFAULTS = { target: 'phone', mode: 'continuous', beep: true, vibrate: true, wake: true, repeat: 1.5, sumQty: false };
  const HISTORY_MAX = 50;
  const READ_OPTS = {
    formats: [],               // all supported formats
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    tryDownscale: true,
    maxNumberOfSymbols: 4,
    returnErrors: true,        // damaged codes are reported (never typed)
  };

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
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        });
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

      if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
        track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
      }

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

    async read(sx, sy, sw, sh, dw, dh) {
      const canvas = this.canvas;
      if (canvas.width !== dw) canvas.width = dw;
      if (canvas.height !== dh) canvas.height = dh;
      this.ctx.drawImage($('video'), sx, sy, sw, sh, 0, 0, dw, dh);
      const image = this.ctx.getImageData(0, 0, dw, dh);
      return ZXingWASM.readBarcodes(image, READ_OPTS);
    },

    async decodeFrame(video) {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      this.frameNo += 1;
      let invalid = false;

      // Pass 1: whole picture (scaled to 1280 on the long side for speed)
      const scale = Math.min(1, 1280 / Math.max(vw, vh));
      let results = await this.read(0, 0, vw, vh, Math.round(vw * scale), Math.round(vh * scale));
      let valid = results.filter((r) => r.isValid && r.text);
      if (valid.length) return { valid, invalid: false };
      invalid = results.some((r) => !r.isValid && r.text);

      // Pass 2 (every 2nd frame): center of the picture at full resolution – small barcodes
      if (this.frameNo % 2 === 0) {
        const cw = Math.round(vw * 0.6);
        const ch = Math.round(vh * 0.6);
        const sx = Math.round((vw - cw) / 2);
        const sy = Math.round((vh - ch) / 2);
        const factor = Math.max(1, Math.min(2, 900 / Math.max(cw, ch)));
        results = await this.read(sx, sy, cw, ch, Math.round(cw * factor), Math.round(ch * factor));
        valid = results.filter((r) => r.isValid && r.text);
        if (valid.length) return { valid, invalid: false };
        invalid = invalid || results.some((r) => !r.isValid && r.text);
      }
      return { valid: [], invalid };
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
      renderHistory();
      toast('החיבור למחשב יופעל בעדכון הבא · הסריקה נשמרה');
      return;
    }

    copyText(code).then((ok) => {
      entry.copied = ok;
      saveHistory();
      renderHistory();
      toast(ok ? `הועתק · ${code}` : `נסרק · הקש "העתק" כדי להעתיק`);
    });
    renderHistory();
  }

  // ---------------------------------------------------------------- rendering
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
          const ok = await copyText(item.code);
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
    pc: 'אחרי עדכון Cubey Scanner במחשב, הסריקה תוקלד בשדה שבו נמצא הסמן.',
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
      if (scanner.running) scanner.stop();
      else scanner.start();
    });
    $('btnTorch').addEventListener('click', () => scanner.toggleTorch());
    $('zoom').addEventListener('input', (e) => scanner.setZoom(e.target.value));

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
    $('btnShare').hidden = !canShareFiles();
    $('btnShare').addEventListener('click', shareExcel);

    // settings dialog
    const dialog = $('settingsDialog');
    $('btnSettings').addEventListener('click', () => {
      $('setBeep').checked = !!settings.beep;
      $('setVibrate').checked = !!settings.vibrate;
      $('setWake').checked = !!settings.wake;
      $('setRepeat').value = String(settings.repeat);
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    });
    $('setBeep').addEventListener('change', (e) => { settings.beep = e.target.checked; saveSettings(); if (settings.beep) { ensureAudio(); beep(); } });
    $('setVibrate').addEventListener('change', (e) => { settings.vibrate = e.target.checked; saveSettings(); });
    $('setWake').addEventListener('change', (e) => { settings.wake = e.target.checked; saveSettings(); });
    $('setRepeat').addEventListener('change', (e) => { settings.repeat = Number(e.target.value); saveSettings(); });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && scanner.running) scanner.stop();
    });
  }

  // ---------------------------------------------------------------- start
  function init() {
    $('appVersion').textContent = APP_VERSION;
    bind();
    setMode(settings.mode === 'single' ? 'single' : 'continuous');
    setTarget(['pc', 'phone', 'list'].includes(settings.target) ? settings.target : 'phone');
    renderHistory();
    renderList();
    prepareDecoder().catch(() => { /* retried on start */ });

    const local = ['localhost', '127.0.0.1'].includes(location.hostname);
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || local)) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  // test hook (used by automated tests only)
  window.__cubey = { scanner, onScan, buildWorkbook, get list() { return list; }, get history() { return history; }, settings };

  init();
})();
