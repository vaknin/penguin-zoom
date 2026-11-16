// Spike page logic. Loaded before the SDK so error capture is in place first.

// WebKitGTK 2.54 has no Screen Orientation API, and the SDK's media code reads
// `screen.orientation.type` when starting audio/video. A desktop window is
// always landscape, so expose a read-only stand-in (a page shim, not an SDK edit).
if (!('orientation' in screen) || !screen.orientation) {
  const orientation = Object.assign(new EventTarget(), {
    get type() { return innerWidth >= innerHeight ? 'landscape-primary' : 'portrait-primary'; },
    angle: 0,
    onchange: null,
    lock: () => Promise.reject(new DOMException('not supported', 'NotSupportedError')),
    unlock: () => {},
  });
  Object.defineProperty(Screen.prototype, 'orientation', { configurable: true, get: () => orientation });
}

// Diagnostic (?workerlog): the SDK's worker blobs call a global
// `snowplow_error` that only exists on the main thread, so a worker's error
// report dies as a ReferenceError and the real message is lost. Start each
// classic blob worker with a prelude that defines it and forwards worker
// errors to /api/log, then load the original script unchanged.
if (location.search.includes('workerlog')) {
  const OrigWorker = window.Worker;
  const prelude = `
    const __send = (m) => { try { fetch('/api/log', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level: 'worker', msg: String(m).slice(0, 4000) }) }); } catch {} };
    const __fmt = (a) => a.map((x) => { try { return typeof x === 'string' ? x : (x instanceof Error ? x.name + ': ' + x.message + ' ' + (x.stack || '') : JSON.stringify(x)); } catch { return String(x); } }).join(' ');
    self.snowplow_error = (...a) => __send('snowplow_error ' + __fmt(a));
    self.addEventListener('error', (e) => __send('onerror ' + e.message + ' @' + e.filename + ':' + e.lineno));
    self.addEventListener('unhandledrejection', (e) => __send('unhandledrejection ' + __fmt([e.reason])));
    for (const l of ['error', 'warn']) { const o = console[l]; console[l] = (...a) => { __send(l + ' ' + __fmt(a)); o.apply(console, a); }; }
  `;
  window.Worker = function (url, opts) {
    const u = String(url);
    if ((opts && opts.type === 'module')) return new OrigWorker(url, opts);
    const abs = new URL(u, location.href).href;
    // The SDK revokes its blob URL right after `new Worker`, so read the
    // script now (sync XHR) and inline it; plain URLs are imported.
    let body = `\nimportScripts(${JSON.stringify(abs)});\n`;
    if (abs.startsWith('blob:')) {
      try { const x = new XMLHttpRequest(); x.open('GET', abs, false); x.send(); body = '\n' + x.responseText; }
      catch (e) { window.spikeLog?.('media', 'workerlog: could not read blob, not wrapping ' + e.message); return new OrigWorker(url, opts); }
    }
    const blob = new Blob([prelude + body], { type: 'text/javascript' });
    window.spikeLog?.('media', `worker (wrapped): ${u.slice(0, 80)} name=${opts?.name || ''}`);
    return new OrigWorker(URL.createObjectURL(blob), opts);
  };
  window.Worker.prototype = OrigWorker.prototype;
}

// Diagnostic: log getDisplayMedia calls (screen share goes through the portal).
if (navigator.mediaDevices?.getDisplayMedia) {
  const orig = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getDisplayMedia = async (c) => {
    window.spikeLog?.('media', 'getDisplayMedia ' + JSON.stringify(c || {}));
    try {
      const s = await orig(c);
      const t = s.getVideoTracks()[0];
      window.spikeLog?.('media', `getDisplayMedia ok "${t?.label}" ${JSON.stringify(t?.getSettings?.() || {})}`);
      t?.addEventListener('ended', () => window.spikeLog?.('media', 'display track ended'));
      return s;
    } catch (e) { window.spikeLog?.('media', `getDisplayMedia failed ${e.name} ${e.message}`); throw e; }
  };
}

// Diagnostic: log every AudioContext and its state changes (a suspended
// context renders exact silence).
{
  const Orig = window.AudioContext;
  window.AudioContext = class extends Orig {
    constructor(...a) {
      super(...a);
      const id = Math.random().toString(36).slice(2, 6);
      const log = (what) => window.spikeLog?.('media', `AudioContext ${id} ${what}: state=${this.state} rate=${this.sampleRate} opts=${JSON.stringify(a[0] || {})}`);
      log('created');
      this.addEventListener('statechange', () => log('statechange'));
      setTimeout(() => log('+5s'), 5000);
    }
  };
}

// Diagnostic: log every MediaStream assigned to a <video>, with where it lives,
// to see how the SDK renders the local camera (WebKitGTK only loads a camera
// stream into a video element that is rendered inside the viewport).
{
  const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
    configurable: true,
    get() { return desc.get.call(this); },
    set(v) {
      // WebKitGTK workaround: a MediaStream <video> outside the viewport never
      // loads (no loadedmetadata), and the SDK parks its capture element at
      // -10000,-10000. Keep it inside the viewport but invisible instead.
      // Off with ?noviewportfix.
      if (v && v.getVideoTracks?.().length && this.id !== 'preview' && !location.search.includes('noviewportfix')) {
        // The screen-share capture <video> is display:none (rect 0x0): it
        // needs a real rendered box too, so force display and a size.
        const pin = () => {
          const r = this.getBoundingClientRect();
          const shown = this.isConnected && getComputedStyle(this).display !== 'none' && r.width > 0 && r.height > 0;
          if (shown && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight) return;
          const props = [['position', 'fixed'], ['left', '0'], ['top', '0'], ['opacity', '0'],
                         ['pointer-events', 'none'], ['z-index', '-1'], ['display', 'block'], ['visibility', 'visible']];
          if (!(r.width > 0 && r.height > 0)) props.push(['width', '320px'], ['height', '180px']);
          for (const [k, val] of props) this.style.setProperty(k, val, 'important');
          window.spikeLog?.('media', `pinned hidden/off-viewport <video> into the viewport (opacity 0, was ${Math.round(r.width)}x${Math.round(r.height)} at ${Math.round(r.x)},${Math.round(r.y)})`);
        };
        if (this.isConnected) pin(); else queueMicrotask(pin);
      }
      desc.set.call(this, v);
      if (v && v.getAudioTracks && !v.getVideoTracks().length && v.getAudioTracks().length) {
        const el = this;
        const where = () => `<${el.tagName.toLowerCase()}> connected=${el.isConnected} paused=${el.paused} muted=${el.muted} volume=${el.volume} readyState=${el.readyState} autoplay=${el.autoplay} track=${v.getAudioTracks()[0].readyState}/${v.getAudioTracks()[0].enabled}`;
        window.spikeLog?.('media', `srcObject <- audio-only stream: ${where()}`);
        setTimeout(() => window.spikeLog?.('media', `audio +3s: ${where()}`), 3000);
      }
      if (v && v.getVideoTracks && v.getVideoTracks().length && this.id !== 'preview') {
        const where = () => {
          const r = this.getBoundingClientRect();
          const cs = this.isConnected ? getComputedStyle(this) : null;
          return `connected=${this.isConnected} display=${cs?.display} vis=${cs?.visibility} opacity=${cs?.opacity} rect=${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)} autoplay=${this.autoplay} muted=${this.muted} readyState=${this.readyState}`;
        };
        window.spikeLog?.('media', `srcObject <- camera stream: ${where()}`);
        setTimeout(() => window.spikeLog?.('media', `+3s: ${where()}`), 3000);
      }
    },
  });
}

(() => {
  const $ = (id) => document.getElementById(id);
  const fmt = (a) => a.map((x) => {
    if (x instanceof Error) return `${x.name}: ${x.message}\n${x.stack || ''}`;
    if (typeof x === 'string') return x;
    try { return JSON.stringify(x); } catch { return String(x); }
  }).join(' ');

  // ---- forward console + errors to the terminal ----
  const send = (level, msg) => {
    try {
      fetch('/api/log', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level, msg: String(msg).slice(0, 4000) }), keepalive: true });
    } catch {}
  };
  const ui = (level, msg) => {
    const el = $('log');
    if (!el) return;
    el.textContent += `[${level}] ${msg}\n`;
    el.scrollTop = el.scrollHeight;
  };
  window.spikeLog = (level, ...a) => { const m = fmt(a); send(level, m); ui(level, m); };
  for (const level of ['error', 'warn']) {
    const orig = console[level];
    console[level] = (...a) => { send(level, fmt(a)); orig.apply(console, a); };
  }
  window.addEventListener('error', (e) => {
    const where = e.filename || (e.target && (e.target.src || e.target.href)) || '';
    spikeLog('error', `${e.message || e.type} @ ${where}:${e.lineno || ''}`);
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    spikeLog('error', 'unhandledrejection ' + (r instanceof Error ? fmt([r]) : fmt([r])));
  });
  window.addEventListener('securitypolicyviolation', (e) => spikeLog('warn', `CSP/COEP ${e.violatedDirective} ${e.blockedURI}`));

  // ---- diagnostics ----
  const rows = [];
  const row = (k, v, good) => {
    rows.push([k, v, good]);
    const cls = good === true ? 'ok' : good === false ? 'bad' : '';
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${k}</td><td class="${cls}"></td>`;
    tr.lastChild.textContent = String(v);
    $('diag').appendChild(tr);
  };
  const probe = (k, f, want) => {
    let v; try { v = f(); } catch (e) { v = 'ERR ' + e.message; }
    row(k, v, want === undefined ? undefined : v === want);
  };

  async function diagnostics() {
    probe('crossOriginIsolated', () => crossOriginIsolated, true);
    probe('SharedArrayBuffer', () => typeof SharedArrayBuffer, 'function');
    probe('RTCPeerConnection (expect missing)', () => typeof RTCPeerConnection);
    probe('isSecureContext', () => isSecureContext, true);
    probe('getUserMedia', () => typeof navigator.mediaDevices?.getUserMedia, 'function');
    probe('getDisplayMedia', () => typeof navigator.mediaDevices?.getDisplayMedia, 'function');
    for (const k of ['VideoEncoder', 'VideoDecoder', 'AudioEncoder', 'AudioDecoder'])
      probe(k, () => typeof window[k], 'function');
    probe('AudioWorklet', () => typeof AudioWorkletNode, 'function');
    probe('WASM SIMD', () => WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11])), true);
    probe('OffscreenCanvas webgl2', () => !!new OffscreenCanvas(4, 4).getContext('webgl2'), true);
    probe('setSinkId (expect missing)', () => typeof HTMLMediaElement.prototype.setSinkId);
    probe('devicePixelRatio', () => devicePixelRatio);
    try {
      const st = await (await fetch('/api/status')).json();
      row('JSC SAB env', st.sabEnv ?? 'unset', st.sabEnv === '1');
      row('video_webrtc_mode', st.webrtcMode);
      setAuth(st);
    } catch (e) { row('/api/status', 'ERR ' + e.message, false); }
  }

  function setAuth(st) {
    window.spikeSignedIn = !!st.signedIn;
    $('auth').textContent = st.signedIn
      ? `signed in${st.user ? ' as ' + st.user : ''} (joins with ZAK)`
      : `not signed in (JWT-only join)${st.publicClientConfigured ? '' : ', public client ID not set'}`;
    $('signin').disabled = !st.publicClientConfigured;
  }

  // ---- local capture test ----
  let previewStream;
  async function testCapture() {
    try {
      previewStream?.getTracks().forEach((t) => t.stop());
      previewStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: 1280, height: 720 } });
      $('preview').srcObject = previewStream;
      setTimeout(() => spikeLog('info', `preview readyState=${$('preview').readyState} ${$('preview').videoWidth}x${$('preview').videoHeight}`), 3000);
      const [vt] = previewStream.getVideoTracks();
      const [at] = previewStream.getAudioTracks();
      spikeLog('info', `capture ok: video="${vt?.label}" ${JSON.stringify(vt?.getSettings?.() ?? {})}, audio="${at?.label}"`);
      const ac = new AudioContext();
      const an = ac.createAnalyser(); an.fftSize = 512;
      ac.createMediaStreamSource(previewStream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      let peak = 0;
      const tick = () => {
        if (!previewStream?.active) return;
        an.getByteTimeDomainData(buf);
        let m = 0; for (const b of buf) m = Math.max(m, Math.abs(b - 128));
        peak = Math.max(peak, m);
        $('meter').firstChild.style.width = Math.min(100, m / 1.28) + '%';
        requestAnimationFrame(tick);
      };
      tick();
      setTimeout(() => spikeLog('info', `mic peak over 5s: ${peak}/128`), 5000);
      const devs = await navigator.mediaDevices.enumerateDevices();
      spikeLog('info', 'devices: ' + devs.map((d) => `${d.kind}:${d.label || '(no label)'}`).join(', '));
    } catch (e) { spikeLog('error', 'getUserMedia failed: ' + e.name + ' ' + e.message); }
  }
  function stopPreview() {
    previewStream?.getTracks().forEach((t) => t.stop());
    previewStream = null;
    $('preview').srcObject = null;
  }
  async function testShare() {
    // ?choosepick: show the picker even if a choice is remembered (screencast.js).
    if (new URLSearchParams(location.search).has('choosepick')) window.__zcShareChoose = true;
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const [t] = s.getVideoTracks();
      spikeLog('info', `screen capture ok: "${t.label}" ${JSON.stringify(t.getSettings())}`);
      if (new URLSearchParams(location.search).get('probegrab') === 'screen') { await probeGrab(s, 'screen'); s.getTracks().forEach((x) => x.stop()); return; }
      $('preview').srcObject = s;
      t.onended = () => spikeLog('info', 'screen capture ended');
      setTimeout(() => spikeLog('info', `share preview readyState=${$('preview').readyState} ${$('preview').videoWidth}x${$('preview').videoHeight}`), 4000);
      setTimeout(() => { s.getTracks().forEach((x) => x.stop()); }, 8000);
    } catch (e) { spikeLog('error', 'getDisplayMedia failed: ' + e.name + ' ' + e.message); }
  }

  // ---- ?probevideo: when does a camera <video> fire loadedmetadata? ----
  // The SDK fails with "Video loadedmetadata timeout"; find the variant that breaks.
  async function probeVideo() {
    const variants = [
      { name: 'VISIBLE fixed+autoplay', attach: true, hide: 'visible', autoplay: true },
      { name: 'VISIBLE fixed+play', attach: true, hide: 'visible', play: true },
      { name: 'visible, opacity 0 +play', attach: true, hide: 'opacity', play: true },
      { name: 'attached+autoplay', attach: true, autoplay: true },
      { name: 'detached+autoplay', attach: false, autoplay: true },
      { name: 'attached+play', attach: true, play: true },
      { name: 'attached, no play', attach: true, play: false },
      { name: 'detached+play', attach: false, play: true },
      { name: 'detached, no play', attach: false, play: false },
      { name: 'display:none+play', attach: true, hide: 'none', play: true },
      { name: 'offscreen 1px+play', attach: true, hide: 'tiny', play: true },
    ];
    const constraints = [
      { name: '1280x720', c: { width: 1280, height: 720 } },
      { name: '640x360@30', c: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30 } } },
      { name: 'default', c: true },
    ];
    const only = new URLSearchParams(location.search).get('probevideo');
    if (only && only !== '1') {
      constraints.splice(1);
      for (let i = variants.length - 1; i >= 0; i--) if (variants[i].name !== only) variants.splice(i, 1);
    }
    for (const k of constraints) {
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ video: k.c, audio: !!k.audio }); }
      catch (e) { spikeLog('probe', `${k.name}: gUM ${e.name} ${e.message}`); continue; }
      const s = stream.getVideoTracks()[0].getSettings();
      for (const v of variants) {
        const el = document.createElement('video');
        el.muted = true; el.playsInline = true; el.autoplay = !!v.autoplay;
        if (v.hide === 'none') el.style.display = 'none';
        if (v.hide === 'visible') Object.assign(el.style, { position: 'fixed', left: '320px', top: '60px', width: '320px', height: '180px', zIndex: 9 });
        if (v.hide === 'opacity') Object.assign(el.style, { position: 'fixed', left: '320px', top: '60px', width: '320px', height: '180px', opacity: 0 });
        if (v.hide === 'tiny') Object.assign(el.style, { position: 'fixed', left: '-10px', top: '-10px', width: '1px', height: '1px' });
        if (v.attach) document.body.appendChild(el);
        const t0 = performance.now();
        const got = new Promise((res) => {
          el.addEventListener('loadedmetadata', () => res(`loadedmetadata ${Math.round(performance.now() - t0)}ms ${el.videoWidth}x${el.videoHeight}`), { once: true });
          setTimeout(() => res(`TIMEOUT readyState=${el.readyState}`), 4000);
        });
        el.srcObject = stream;
        let playRes = '';
        if (v.play) playRes = await Promise.race([el.play().then(() => 'play ok', (e) => 'play ' + e.name), new Promise((r) => setTimeout(() => r('play pending'), 4000))]);
        spikeLog('probe', `${k.name} (${s.width}x${s.height}@${s.frameRate}) ${v.name}: ${await got} ${playRes}`);
        el.srcObject = null; el.remove();
      }
      stream.getTracks().forEach((t) => t.stop());
    }
    spikeLog('probe', 'done');
  }


  // ---- ?probegrab=cam|screen: can page code read pixels from a capture
  // <video>? Tries every path the SDK might use to grab frames for encoding
  // and logs the mean brightness (0 = black) of each.
  async function probeGrab(stream, tag) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.autoplay = true;
    Object.assign(v.style, { position: 'fixed', left: '0', top: '0', width: '320px', height: '180px', opacity: 0 });
    document.body.appendChild(v);
    v.srcObject = stream;
    await new Promise((r) => { v.addEventListener('loadeddata', r, { once: true }); setTimeout(r, 4000); });
    await Promise.race([v.play().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
    await new Promise((r) => setTimeout(r, 1500));
    const W = 160, H = 90;
    const mean = (px) => { let s = 0, n = 0; for (let i = 0; i < px.length; i += 4) { s += px[i] + px[i + 1] + px[i + 2]; n += 3; } return (s / n).toFixed(1); };
    const out = { readyState: v.readyState, size: `${v.videoWidth}x${v.videoHeight}` };
    const tryk = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = 'ERR ' + e.name + ' ' + e.message; } };
    await tryk('2d.drawImage', () => { const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.drawImage(v, 0, 0, W, H); return mean(g.getImageData(0, 0, W, H).data); });
    const glRead = (gl, src) => {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      const w = src.videoWidth || src.displayWidth || src.width, h = src.videoHeight || src.displayHeight || src.height;
      const px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return mean(px) + ' err=' + gl.getError();
    };
    await tryk('webgl.texImage2D(video)', () => glRead(document.createElement('canvas').getContext('webgl'), v));
    await tryk('webgl2.texImage2D(video)', () => glRead(document.createElement('canvas').getContext('webgl2'), v));
    await tryk('offscreen.webgl2(video)', () => glRead(new OffscreenCanvas(4, 4).getContext('webgl2'), v));
    await tryk('VideoFrame(video).copyTo', async () => { const f = new VideoFrame(v); const fmt = f.format; const n = f.allocationSize({ format: 'RGBA' }); const b = new Uint8Array(n); await f.copyTo(b, { format: 'RGBA' }); f.close(); return fmt + ' ' + mean(b); });
    await tryk('VideoFrame(video).copyTo native', async () => { const f = new VideoFrame(v); const fmt = f.format; const b = new Uint8Array(f.allocationSize()); await f.copyTo(b); f.close(); let s = 0; const n = Math.min(b.length, f.codedWidth * f.codedHeight); for (let i = 0; i < n; i++) s += b[i]; return fmt + ' Ymean=' + (s / n).toFixed(1); });
    await tryk('createImageBitmap->2d', async () => { const bm = await createImageBitmap(v); const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.drawImage(bm, 0, 0, W, H); return mean(g.getImageData(0, 0, W, H).data); });
    const workerSrc = `
      const mean = ${mean.toString()};
      const glRead = ${glRead.toString()};
      onmessage = async (e) => { const r = {};
        try { r.bitmap_webgl2 = glRead(new OffscreenCanvas(4, 4).getContext('webgl2'), e.data.bm); } catch (x) { r.bitmap_webgl2 = 'ERR ' + x.message; }
        try { r.bitmap_webgl = glRead(new OffscreenCanvas(4, 4).getContext('webgl'), e.data.bm); } catch (x) { r.bitmap_webgl = 'ERR ' + x.message; }
        try { r.frame_webgl2 = glRead(new OffscreenCanvas(4, 4).getContext('webgl2'), e.data.vf); } catch (x) { r.frame_webgl2 = 'ERR ' + x.message; }
        try { const c = new OffscreenCanvas(${W}, ${H}); const g = c.getContext('2d'); g.drawImage(e.data.vf, 0, 0, ${W}, ${H}); r.frame_2d = mean(g.getImageData(0, 0, ${W}, ${H}).data); } catch (x) { r.frame_2d = 'ERR ' + x.message; }
        postMessage(r); };`;
    await tryk('worker', () => new Promise(async (res) => {
      setTimeout(() => res('worker timeout'), 5000);
      try { await createImageBitmap(v); } catch (e) { return res('no frame: ' + e.name); }
      const w = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' })));
      w.onmessage = (e) => { res(JSON.stringify(e.data)); w.terminate(); };
      w.onerror = (e) => res('worker error ' + e.message);
      const bm = await createImageBitmap(v); const vf = new VideoFrame(v);
      w.postMessage({ bm, vf }, [bm, vf]);
    }));
    spikeLog('probe', `grab ${tag}: ` + JSON.stringify(out));
    v.remove();
  }

  // ---- ?beep=<secs>: a 440 Hz tone through a page AudioContext, to validate
  // the playback measurement (null sink + monitor recording) without Zoom.
  // ?beep=<secs>&beepel also plays a tone through an <audio> element fed by a
  // MediaStreamAudioDestinationNode (the other path the SDK might use).
  function beep(secs) {
    const ac = new AudioContext();
    const osc = ac.createOscillator(); osc.frequency.value = 440;
    const g = ac.createGain(); g.gain.value = 0.2;
    osc.connect(g);
    const viaEl = new URLSearchParams(location.search).has('beepel');
    if (viaEl) {
      const dst = ac.createMediaStreamDestination();
      g.connect(dst);
      const el = new Audio(); el.srcObject = dst.stream; el.autoplay = true;
      if (!new URLSearchParams(location.search).has('beepdetached')) document.body.appendChild(el);
      el.play().then(() => spikeLog('beep', 'audio element play ok'), (e) => spikeLog('beep', 'audio element play ' + e.name));
    } else g.connect(ac.destination);
    osc.start();
    ac.resume().catch(() => {});
    spikeLog('beep', `start ${secs}s via ${viaEl ? '<audio>' : 'destination'} state=${ac.state}`);
    setTimeout(() => spikeLog('beep', `+2s state=${ac.state} t=${ac.currentTime.toFixed(2)}`), 2000);
    setTimeout(() => { osc.stop(); spikeLog('beep', 'stop'); }, secs * 1000);
  }

  // ---- ?probeworker: the SDK's worker feature check (OffscreenCanvas contexts
  // inside a worker; bit 2 = "webgl", which picks the share/video render path).
  function probeWorker() {
    const src = `
      const r = {};
      for (const k of ['webgl', 'webgl2', '2d', 'bitmaprenderer']) {
        try { const c = new OffscreenCanvas(1, 1).getContext(k); r[k] = c ? 'ok' : 'null'; } catch (e) { r[k] = 'ERR ' + e.message; }
      }
      r.VideoDecoder = typeof VideoDecoder; r.VideoFrame = typeof VideoFrame; r.createImageBitmap = typeof createImageBitmap;
      r.SAB = typeof SharedArrayBuffer;
      postMessage(r);`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    w.onmessage = (e) => spikeLog('probe', 'worker OffscreenCanvas: ' + JSON.stringify(e.data));
    w.onerror = (e) => spikeLog('probe', 'worker error ' + e.message);
    const r = {};
    for (const k of ['webgl', 'webgl2', '2d']) {
      try { r[k] = new OffscreenCanvas(1, 1).getContext(k) ? 'ok' : 'null'; } catch (e) { r[k] = 'ERR ' + e.message; }
    }
    spikeLog('probe', 'main OffscreenCanvas: ' + JSON.stringify(r));
  }

  // ---- meeting input parsing ----
  function parseMeeting(raw) {
    raw = raw.trim();
    let pwd = '';
    let num = raw;
    try {
      const u = new URL(raw.replace(/^zoommtg:/, 'https:'));
      pwd = u.searchParams.get('pwd') || '';
      const m = u.pathname.match(/\/(?:j|wc\/join|s)\/(\d+)/) || [null, u.searchParams.get('confno')];
      num = m[1] || '';
    } catch {}
    return { number: (num || '').replace(/\D/g, ''), pwd };
  }

  // ---- SDK ----
  let client;
  async function initSdk() {
    if (typeof ZoomMtgEmbedded === 'undefined') { row('ZoomMtgEmbedded', 'missing', false); return; }
    fetch('/sdk/VERSION').then((r) => r.text()).then((v) => { $('sdkver').textContent = 'SDK ' + v.trim(); }).catch(() => {});
    client = ZoomMtgEmbedded.createClient();
    probe('SDK checkSystemRequirements', () => JSON.stringify(client.checkSystemRequirements()));
    const t0 = performance.now();
    try {
      await client.init({
        zoomAppRoot: $('zoomRoot'),
        language: 'en-US',
        assetPath: location.origin + '/sdk/lib/av',
        patchJsMedia: false,
        leaveOnPageUnload: true,
        customize: {
          video: { isResizable: true, viewSizes: { default: { width: 960, height: 540 } } },
        },
      });
      row('SDK init', `ok (${Math.round(performance.now() - t0)} ms)`, true);
    } catch (e) {
      row('SDK init', 'ERR ' + (e.reason || e.message || JSON.stringify(e)), false);
      spikeLog('error', 'init failed ' + fmt([e]));
      return;
    }
    for (const ev of ['connection-change', 'user-added', 'user-removed', 'active-speaker', 'media-sdk-change',
                      'video-active-change', 'audio-statistic-data-change', 'video-statistic-data-change']) {
      try { client.on(ev, (p) => spikeLog('event', ev + ' ' + fmt([p]).slice(0, 500))); } catch {}
    }
  }

  async function join() {
    const { number, pwd } = parseMeeting($('meeting').value);
    if (!number) { spikeLog('error', 'no meeting number'); return; }
    const password = $('passcode').value.trim() || pwd;
    $('join').disabled = true;
    stopPreview(); // free the camera for the SDK
    try {
      const sr = await fetch('/api/signature', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ meetingNumber: number, role: 0 }) });
      const sj = await sr.json();
      if (!sr.ok) throw new Error('signature: ' + sj.error);
      const opts = { signature: sj.signature, meetingNumber: number, password, userName: $('name').value || 'Linux spike' };
      if (window.spikeSignedIn) {
        const zr = await fetch('/api/zak');
        const zj = await zr.json();
        if (!zr.ok) throw new Error('zak: ' + zj.error);
        opts.zak = zj.zak;
      }
      spikeLog('info', `joining …${number.slice(-3)} ${opts.zak ? 'with ZAK' : 'JWT only'}`);
      const t0 = performance.now();
      await client.join(opts);
      spikeLog('info', `joined in ${Math.round(performance.now() - t0)} ms`);
      $('leave').disabled = false;
    } catch (e) {
      spikeLog('error', 'join failed: ' + (e.reason || e.message || fmt([e])) + (e.errorCode ? ` (code ${e.errorCode})` : ''));
      $('join').disabled = false;
    }
  }

  // ---- headless test automation (URL params, no arbitrary eval) ----
  // ?autoav: click the SDK's own "join audio" / "start video" / "unmute" buttons
  // as they appear, the same as a person would.
  const visibleButtons = () => [...$('zoomRoot').querySelectorAll('button, [role=button]')]
    .filter((b) => b.offsetParent !== null);
  const btnLabel = (b) => (b.getAttribute('aria-label') || b.title || b.textContent || '').trim().replace(/\s+/g, ' ');
  function autoAV() {
    // ?autoav=audio|video|both (default both). Each label is clicked at most
    // once per 30 s, so a slow "Start Video" is not hammered.
    const mode = new URLSearchParams(location.search).get('autoav') || 'both';
    const want = [];
    if (mode !== 'video') want.push(/^audio$/i, /join audio/i, /computer audio/i, /^unmute/i);
    if (mode !== 'audio') want.push(/^start video$/i);
    // ?autoshare=<secs>: click the SDK's "Share Screen" once, <secs> after join.
    const shareAt = Number(new URLSearchParams(location.search).get('autoshare') || 0);
    if (shareAt) setTimeout(() => {
      const b = visibleButtons().find((x) => /^share screen$/i.test(btnLabel(x)));
      spikeLog('auto', b ? 'click "Share Screen"' : 'no "Share Screen" button');
      b?.click();
    }, shareAt * 1000);
    const last = new Map();
    let n = 0;
    const t = setInterval(() => {
      if (++n > 120) { clearInterval(t); return; }
      for (const b of visibleButtons()) {
        const l = btnLabel(b);
        if (!want.some((r) => r.test(l))) continue;
        if (Date.now() - (last.get(l) || 0) < 30000) continue;
        last.set(l, Date.now());
        spikeLog('auto', `click "${l}"`);
        b.click();
      }
    }, 2000);
  }

  // Periodic in-meeting state: who is there, audio/video flags, SDK toolbar labels.
  function startStats() {
    const dump = () => {
      try {
        const me = client.getCurrentUser?.();
        const users = client.getAttendeeslist?.() || [];
        spikeLog('stats', JSON.stringify({
          me: me && { audio: me.audio, muted: me.muted, bVideoOn: me.bVideoOn, isHost: me.isHost },
          users: users.map((u) => ({ name: u.displayName?.slice(0, 20), audio: u.audio, muted: u.muted, video: u.bVideoOn })),
          buttons: visibleButtons().map(btnLabel).filter(Boolean).slice(0, 25),
          videos: [...document.querySelectorAll('#zoomRoot video, #zoomRoot canvas')].map((v) => `${v.tagName}:${v.width}x${v.height}`),
        }));
      } catch (e) { spikeLog('stats', 'ERR ' + e.message); }
    };
    setTimeout(dump, 5000);
    setInterval(dump, 15000);
  }

  async function leave() {
    try { await client.leaveMeeting(); spikeLog('info', 'left'); } catch (e) { spikeLog('error', 'leave: ' + fmt([e])); }
    $('leave').disabled = true; $('join').disabled = false;
  }

  window.spikeMain = async () => {
    $('join').onclick = join;
    $('leave').onclick = leave;
    $('capture').onclick = testCapture;
    $('share').onclick = testShare;
    $('signin').onclick = () => { location.href = '/oauth/login'; };
    const m = new URLSearchParams(location.search).get('m');
    if (m) $('meeting').value = m;
    await diagnostics();
    await initSdk();
    spikeLog('info', 'diagnostics: ' + rows.map(([k, v]) => `${k}=${v}`).join('; '));
    const q = new URLSearchParams(location.search);
    if (q.has('autotest')) await testCapture();
    if (q.has('probevideo')) await probeVideo();
    if (q.has('beep')) beep(Number(q.get('beep')) || 30);
    if (q.has('probeworker')) probeWorker();
    if (q.get('probegrab') === 'cam') {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const cam = devs.find((d) => d.kind === 'videoinput' && /UVC/.test(d.label)) || devs.find((d) => d.kind === 'videoinput' && !/Fake/.test(d.label));
      const st = await navigator.mediaDevices.getUserMedia({ video: { deviceId: cam ? { exact: cam.deviceId } : undefined, width: 1280, height: 720 } });
      await probeGrab(st, 'cam ' + (cam?.label || '?'));
      st.getTracks().forEach((x) => x.stop());
    }
    // ?probecanvas: does the page render at all (requestAnimationFrame), and
    // does a canvas.captureStream() track load into a <video> with pixels?
    if (q.has('probecanvas')) {
      let raf = 0; const t0 = performance.now();
      const tick = () => { raf++; if (performance.now() - t0 < 2000) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      const c = document.createElement('canvas'); c.width = 640; c.height = 360;
      c.style.cssText = 'position:fixed;left:0;top:0;width:16px;height:9px;opacity:0';
      document.body.append(c);
      const x = c.getContext('2d'); let n = 0;
      const paint = () => { x.fillStyle = `hsl(${(n++ * 7) % 360} 80% 50%)`; x.fillRect(0, 0, 640, 360); };
      paint(); const iv = setInterval(paint, 66);
      const variant = q.get('probecanvas') || 'fps';
      const st = variant === 'nofps' ? c.captureStream() : c.captureStream(15);
      setTimeout(async () => {
        spikeLog('probe', `rAF in 2s: ${raf}; hidden=${document.hidden} visibility=${document.visibilityState}`);
        await probeGrab(st, 'canvas-' + variant);
        clearInterval(iv);
      }, 2200);
    }
    if (q.has('testshare')) setTimeout(testShare, Number(q.get('testshare') || 3) * 1000);
    // ?keyshare: getDisplayMedia needs a real user gesture, which a scripted
    // click is not. Tests send a real F9 keypress (wtype) to the window: in a
    // meeting it clicks the SDK's "Share Screen", otherwise runs testShare().
    if (q.has('keyshare')) addEventListener('keydown', (e) => {
      spikeLog('auto', `keydown ${e.key} trusted=${e.isTrusted}`);
      if (e.key !== 'F9') return;
      const b = visibleButtons().find((x) => /^share screen$/i.test(btnLabel(x)));
      spikeLog('auto', `F9 (trusted=${e.isTrusted}) -> ${b ? 'SDK Share Screen' : 'testShare'}`);
      if (b) b.click(); else testShare();
    }, true);
    if (q.get('pwd')) $('passcode').value = q.get('pwd');
    if (q.get('name')) $('name').value = q.get('name');
    if (q.has('autojoin') && $('meeting').value) {
      await join();
      if (q.has('autoav')) autoAV();
      // ?leaveafter=<secs>: leave cleanly, so a killed test run leaves no ghost
      // participant (a ghost that was sharing blocks the next share).
      if (q.get('leaveafter')) setTimeout(leave, Number(q.get('leaveafter')) * 1000);
      startStats();
    }
  };
})();
