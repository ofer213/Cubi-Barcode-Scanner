/* Cubey Scanner – connection from the phone to a PC station.
 *
 * Pairing: the PC shows a QR code (link with #pair=...) holding the station id and a secret key.
 * Transport, chosen automatically:
 *   direct – WebRTC data channel (on the same Wi-Fi it stays inside the local network)
 *   relay  – public MQTT broker over secure WebSockets; every message is AES-256-GCM encrypted
 * Scans are kept in a queue until the PC confirms them (ack), so nothing is lost when the PC is off.
 */
(() => {
  'use strict';

  const PROTOCOL = 'cubeyscan/v1';
  const DEFAULT_BROKERS = ['wss://broker.hivemq.com:8884/mqtt', 'wss://broker.emqx.io:8084/mqtt'];
  const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  const STORE = {
    stations: 'cubey.stations.v1',
    active: 'cubey.activeStation.v1',
    phone: 'cubey.phoneId.v1',
    pending: 'cubey.pending.v1',
  };
  const ACK_TIMEOUT_MS = 4000;
  const PING_MS = 30000;
  const DIRECT_OPEN_TIMEOUT_MS = 12000;
  const DIRECT_RETRY_MS = 45000;

  // ---------------------------------------------------------------- helpers
  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  }

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function b64uEncode(bytes) {
    let s = '';
    bytes.forEach((b) => { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64uDecode(text) {
    const s = text.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }
  function b64Encode(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b64Decode(text) {
    const bin = atob(text);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }
  const randomId = (n) => b64uEncode(crypto.getRandomValues(new Uint8Array(n)));

  function brokers() {
    const override = load('cubey.dev.brokers', null);   // used only by automated tests
    return Array.isArray(override) && override.length ? override : DEFAULT_BROKERS;
  }

  // ---------------------------------------------------------------- crypto
  const keyCache = new Map();
  async function cryptoKey(keyB64u) {
    if (!keyCache.has(keyB64u)) {
      keyCache.set(keyB64u, crypto.subtle.importKey('raw', b64uDecode(keyB64u), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']));
    }
    return keyCache.get(keyB64u);
  }
  async function encrypt(keyB64u, obj) {
    const key = await cryptoKey(keyB64u);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv, 0);
    out.set(ct, iv.length);
    return b64Encode(out);
  }
  async function decrypt(keyB64u, payload) {
    const key = await cryptoKey(keyB64u);
    const raw = b64Decode(typeof payload === 'string' ? payload : dec.decode(payload));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12) }, key, raw.subarray(12));
    return JSON.parse(dec.decode(plain));
  }

  // ---------------------------------------------------------------- pairing link
  function parsePairing(text) {
    const match = String(text || '').match(/#pair=([A-Za-z0-9_-]+)/);
    if (!match) return null;
    try {
      const data = JSON.parse(dec.decode(b64uDecode(match[1])));
      if (data && data.v === 1 && /^[A-Za-z0-9_-]{16,40}$/.test(data.s) && b64uDecode(data.k).length === 32) {
        return { id: data.s, key: data.k, name: String(data.n || 'עמדה').slice(0, 60) };
      }
    } catch (e) { /* invalid */ }
    return null;
  }

  // ---------------------------------------------------------------- remote
  class Remote extends EventTarget {
    constructor() {
      super();
      this.phoneId = load(STORE.phone, null);
      if (typeof this.phoneId !== 'string' || !/^[A-Za-z0-9_-]{8,40}$/.test(this.phoneId)) {
        this.phoneId = randomId(12);
        save(STORE.phone, this.phoneId);
      }
      this.stations = load(STORE.stations, []);
      if (!Array.isArray(this.stations)) this.stations = [];
      this.activeId = load(STORE.active, null);
      if (!this.stations.some((s) => s.id === this.activeId)) this.activeId = this.stations.length ? this.stations[0].id : null;
      this.pending = load(STORE.pending, []);
      if (!Array.isArray(this.pending)) this.pending = [];

      this.client = null;
      this.brokerIndex = 0;
      this.relayUp = false;
      this.pcOnline = null;       // null = unknown, true/false from the PC status
      this.pc = null;
      this.dc = null;
      this.directLocal = false;
      this.directTimer = null;
      this.directRetryAt = 0;
      this.pingTimer = null;
      this.ackTimers = new Map();
      this.enabled = false;       // connection runs only while the PC tab is in use
    }

    get active() {
      return this.stations.find((s) => s.id === this.activeId) || null;
    }

    get state() {
      if (!this.active) return 'none';
      if (this.dc && this.dc.readyState === 'open') return this.directLocal ? 'direct-local' : 'direct';
      if (!this.relayUp) return navigator.onLine === false ? 'no-internet' : 'connecting';
      if (this.pcOnline === false) return 'pc-offline';
      if (this.pcOnline === true) return 'relay';
      return 'connecting';
    }

    pendingCount() {
      return this.pending.filter((m) => m.sid === this.activeId).length;
    }

    emit(type, detail) {
      this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    // ------------------------------------------------ stations
    pair(text) {
      const info = parsePairing(text);
      if (!info) return null;
      const existing = this.stations.find((s) => s.id === info.id);
      if (existing) {
        existing.key = info.key;
        existing.name = info.name;
      } else {
        this.stations.push({ id: info.id, key: info.key, name: info.name });
      }
      save(STORE.stations, this.stations);
      this.setActive(info.id);
      return info;
    }

    remove(id) {
      this.stations = this.stations.filter((s) => s.id !== id);
      this.pending = this.pending.filter((m) => m.sid !== id);
      save(STORE.stations, this.stations);
      save(STORE.pending, this.pending);
      if (this.activeId === id) this.setActive(this.stations.length ? this.stations[0].id : null);
      else this.emit('stations');
    }

    setActive(id) {
      if (this.activeId !== id) {
        this.disconnect();
        this.activeId = id;
        save(STORE.active, id);
      }
      this.emit('stations');
      this.emit('status');
      if (this.enabled) this.connect();
    }

    setEnabled(on) {
      this.enabled = on;
      if (on) this.connect();
      else if (!this.pendingCount()) this.disconnect();
    }

    // ------------------------------------------------ relay (MQTT)
    topics() {
      const base = `${PROTOCOL}/${this.activeId}`;
      return { in: `${base}/in`, status: `${base}/status`, out: `${base}/out/${this.phoneId}` };
    }

    connect() {
      const station = this.active;
      if (!station || this.client || typeof mqtt === 'undefined') {
        this.emit('status');
        return;
      }
      const urls = brokers();
      const url = urls[this.brokerIndex % urls.length];
      const t = this.topics();
      const client = mqtt.connect(url, {
        clientId: `cubey-ph-${this.phoneId.slice(0, 10)}-${randomId(3)}`,
        clean: true,
        keepalive: 30,
        connectTimeout: 8000,
        reconnectPeriod: 3000,
      });
      this.client = client;

      let attempts = 0;
      client.on('connect', () => {
        attempts = 0;
        this.relayUp = true;
        client.subscribe([t.out, t.status], { qos: 1 });
        this.publish({ t: 'hello', p: this.phoneId, ua: navigator.userAgent.slice(0, 120) });
        this.startPing();
        this.flush();
        this.emit('status');
      });
      client.on('message', (topic, payload) => {
        decrypt(station.key, payload)
          .then((obj) => this.handle(obj, topic === t.status ? 'status' : 'relay'))
          .catch(() => { /* not for us */ });
      });
      const onDown = () => {
        if (this.client !== client) return;
        this.relayUp = false;
        this.emit('status');
      };
      client.on('close', onDown);
      client.on('offline', onDown);
      client.on('error', onDown);
      client.on('reconnect', () => {
        // the relay is unreachable: after two failed attempts switch to the other relay
        attempts += 1;
        if (this.client === client && attempts >= 2 && urls.length > 1) {
          this.brokerIndex += 1;
          this.closeRelay();
          setTimeout(() => this.connect(), 200);
        }
      });
      this.emit('status');
    }

    closeRelay() {
      if (this.client) {
        try { this.client.end(true); } catch (e) { /* ignore */ }
      }
      this.client = null;
      this.relayUp = false;
    }

    disconnect() {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.closeDirect();
      this.closeRelay();
      this.pcOnline = null;
      this.emit('status');
    }

    startPing() {
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (document.visibilityState === 'visible') this.sendRaw({ t: 'ping', p: this.phoneId });
      }, PING_MS);
    }

    async publish(obj) {
      const station = this.active;
      if (!station || !this.client || !this.relayUp) return false;
      try {
        const payload = await encrypt(station.key, obj);
        this.client.publish(this.topics().in, payload, { qos: 1 });
        return true;
      } catch (e) {
        return false;
      }
    }

    sendRaw(obj) {
      if (this.dc && this.dc.readyState === 'open') {
        try {
          this.dc.send(JSON.stringify(obj));
          return Promise.resolve(true);
        } catch (e) { /* fall back to relay */ }
      }
      return this.publish(obj);
    }

    handle(obj, via) {
      if (!obj || typeof obj !== 'object') return;
      if (obj.t === 'status') {
        const station = this.active;
        this.pcOnline = !!obj.online;
        if (station && obj.name && station.name !== obj.name) {
          station.name = String(obj.name).slice(0, 60);
          save(STORE.stations, this.stations);
          this.emit('stations');
        }
        if (this.pcOnline) {
          this.flush();
          this.maybeStartDirect();
        } else {
          this.closeDirect();
        }
        this.emit('status');
      } else if (obj.t === 'ack' && obj.id) {
        const before = this.pending.length;
        this.pending = this.pending.filter((m) => m.id !== obj.id);
        if (this.pending.length !== before) save(STORE.pending, this.pending);
        clearTimeout(this.ackTimers.get(obj.id));
        this.ackTimers.delete(obj.id);
        this.emit('ack', { id: obj.id, result: obj.r || 'typed' });
        this.emit('status');
      } else if (obj.t === 'answer' && typeof obj.sdp === 'string' && this.pc) {
        this.pc.setRemoteDescription({ type: 'answer', sdp: obj.sdp }).catch(() => this.closeDirect(true));
      } else if (obj.t === 'nodirect') {
        this.closeDirect(true);
      }
    }

    // ------------------------------------------------ direct (WebRTC)
    maybeStartDirect() {
      if (!this.enabled || !window.RTCPeerConnection || this.pc || !this.relayUp || this.pcOnline !== true) return;
      if (Date.now() < this.directRetryAt) return;
      this.startDirect().catch(() => this.closeDirect(true));
    }

    async startDirect() {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      this.pc = pc;
      const dc = pc.createDataChannel('cubey-scans', { ordered: true });
      this.dc = dc;
      this.directLocal = false;

      dc.onopen = () => {
        if (this.dc !== dc) return;
        clearTimeout(this.directTimer);
        this.detectLocal(pc);
        this.sendRaw({ t: 'hello', p: this.phoneId });
        this.flush();
        this.emit('status');
      };
      dc.onmessage = (event) => {
        try { this.handle(JSON.parse(event.data), 'direct'); } catch (e) { /* ignore */ }
      };
      dc.onclose = () => {
        if (this.dc === dc) this.closeDirect(true);
      };
      pc.onconnectionstatechange = () => {
        if (this.pc === pc && ['failed', 'closed', 'disconnected'].includes(pc.connectionState)) this.closeDirect(true);
      };

      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') return resolve();
        const done = () => { if (pc.iceGatheringState === 'complete') resolve(); };
        pc.addEventListener('icegatheringstatechange', done);
        setTimeout(resolve, 2500);
      });
      if (this.pc !== pc) return;
      await this.publish({ t: 'offer', p: this.phoneId, sdp: pc.localDescription.sdp });
      this.directTimer = setTimeout(() => {
        if (this.dc === dc && dc.readyState !== 'open') this.closeDirect(true);
      }, DIRECT_OPEN_TIMEOUT_MS);
    }

    async detectLocal(pc) {
      try {
        const stats = await pc.getStats();
        let pair = null;
        stats.forEach((r) => {
          if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
        });
        if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
        const local = pair && stats.get(pair.localCandidateId);
        const remote = pair && stats.get(pair.remoteCandidateId);
        this.directLocal = !!(local && remote && local.candidateType === 'host' && ['host', 'prflx'].includes(remote.candidateType));
      } catch (e) {
        this.directLocal = false;
      }
      this.emit('status');
    }

    closeDirect(retryLater) {
      clearTimeout(this.directTimer);
      const pc = this.pc;
      const dc = this.dc;
      this.pc = null;
      this.dc = null;
      this.directLocal = false;
      try { if (dc) dc.close(); } catch (e) { /* ignore */ }
      try { if (pc) pc.close(); } catch (e) { /* ignore */ }
      if (retryLater) {
        this.directRetryAt = Date.now() + DIRECT_RETRY_MS;
        setTimeout(() => this.maybeStartDirect(), DIRECT_RETRY_MS + 100);
      }
      this.emit('status');
    }

    // ------------------------------------------------ scans
    send(code, fmt) {
      const station = this.active;
      if (!station) return null;
      const msg = { t: 'scan', id: randomId(9), code, fmt: fmt || '', ts: Date.now(), p: this.phoneId, sid: station.id };
      this.pending.push(msg);
      save(STORE.pending, this.pending);
      this.trySend(msg);
      this.emit('status');
      return msg.id;
    }

    trySend(msg) {
      if (msg.sid !== this.activeId) return;
      const { sid, ...wire } = msg;
      this.sendRaw(wire).then((sent) => {
        clearTimeout(this.ackTimers.get(msg.id));
        if (!sent) return;   // flushed again when the connection comes back
        this.ackTimers.set(msg.id, setTimeout(() => {
          this.ackTimers.delete(msg.id);
          if (!this.pending.some((m) => m.id === msg.id)) return;
          // no confirmation: the direct link may be stale – resend through the relay
          if (this.dc && this.dc.readyState === 'open') this.closeDirect(true);
          this.publish(wire);
        }, ACK_TIMEOUT_MS));
      });
    }

    flush() {
      for (const msg of this.pending) {
        if (msg.sid === this.activeId && !this.ackTimers.has(msg.id)) this.trySend(msg);
      }
    }

    clearPending() {
      this.pending = this.pending.filter((m) => m.sid !== this.activeId);
      save(STORE.pending, this.pending);
      this.emit('status');
    }
  }

  window.CubeyRemote = { Remote, parsePairing, encrypt, decrypt };
})();
