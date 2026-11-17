// Thin glue between the Rust/Leptos UI and Zoom's Meeting SDK for Web
// (component view). Everything the UI needs goes through window.zc; state
// goes back as JSON strings through the callback given to zc.init().
//
// Zoom's public embedded API covers mute, leave, view type, chat and breakout
// rooms. It has no calls for camera on/off, screen share or picking a camera
// or microphone, so for those we press Zoom's own toolbar buttons, which stay
// in the DOM but are collapsed out of sight (see hideZoomChrome). Labels are
// from SDK 6.10.0; re-check them when the SDK is upgraded.
// WebKitGTK 2.54 has no Screen Orientation API, and the SDK's media code reads
// `screen.orientation.type` when starting audio/video (PLAN.md §4.1). A desktop
// window is landscape, so expose a read-only stand-in.
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

// WebKitGTK workaround (PLAN.md §4.2): a MediaStream <video> that isn't
// rendered inside the viewport never loads, so Zoom's camera and share capture
// elements (parked at -10000,-10000 or display:none) stall and "Start video"
// never finishes. Keep any such element inside the viewport but invisible.
{
  const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
    configurable: true,
    get() { return desc.get.call(this); },
    set(v) {
      if (v && v.getVideoTracks?.().length && this.id !== 'previewVideo') {
        const pin = () => {
          const r = this.getBoundingClientRect();
          const shown = this.isConnected && getComputedStyle(this).display !== 'none' && r.width > 0 && r.height > 0;
          if (shown && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight) return;
          const props = [['position', 'fixed'], ['left', '0'], ['top', '0'], ['opacity', '0'],
                         ['pointer-events', 'none'], ['z-index', '-1'], ['display', 'block'], ['visibility', 'visible']];
          if (!(r.width > 0 && r.height > 0)) props.push(['width', '320px'], ['height', '180px']);
          for (const [k, val] of props) this.style.setProperty(k, val, 'important');
          // An ancestor can still hide it (our UI collapses Zoom's toolbar
          // area). Then move it into a holder that is rendered but invisible.
          const r2 = this.getBoundingClientRect();
          if (!(this.isConnected && r2.width > 0 && r2.height > 0 && (this.checkVisibility?.() ?? true))) {
            let holder = document.getElementById('zcMediaHolder');
            if (!holder) {
              holder = document.createElement('div');
              holder.id = 'zcMediaHolder';
              holder.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:180px;opacity:0;pointer-events:none;z-index:-1;overflow:hidden';
              document.body.append(holder);
            }
            holder.append(this);
            fetch('/api/log', { method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ level: 'info', msg: 'glue: moved a hidden capture <video> into the holder' }) }).catch(() => {});
          }
        };
        // The SDK may attach or move the element after setting the stream, so
        // check again over the next two seconds.
        if (this.isConnected) pin(); else queueMicrotask(pin);
        for (const ms of [50, 300, 1000, 2000]) setTimeout(pin, ms);
      }
      desc.set.call(this, v);
    },
  });
}

// The camera/mic the user picked, applied to every capture (Zoom's own menus
// only exist while video/audio is on). With no pick, requests go through
// unchanged: every device stays available and nothing is chosen for the user.
window.__zcDev = { camera: null, mic: null, cameraId: null, micId: null }; // chosen device labels and ids
{
  const gum = MediaDevices.prototype.getUserMedia;
  const resolve = async (c, kind, want, wantId) => {
    if (!c || !(want || wantId)) return c;
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default');
    const o = typeof c === 'object' ? { ...c } : {};
    // Before the first grant WebKit hides ids and labels, but a saved id still
    // opens its device, so the default one is never opened in its place.
    if (!devs.length || !devs[0].label) {
      if (!wantId) return c;
      o.deviceId = { exact: wantId };
      return o;
    }
    const askedId = o.deviceId?.exact ?? o.deviceId?.ideal ?? o.deviceId;
    const asked = devs.find((d) => d.deviceId === askedId);
    const use = devs.find((d) => d.deviceId === wantId) || devs.find((d) => d.label === want);
    if (!use || use === asked) return c;
    o.deviceId = { exact: use.deviceId };
    return o;
  };
  const glog = (level, msg) => fetch('/api/log', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ level, msg: 'devices: ' + msg }) }).catch(() => {});
  const brief = (c) => JSON.stringify(c, (k, v) => (k === 'deviceId' && v ? '[set]' : v)).slice(0, 160);
  MediaDevices.prototype.getUserMedia = async function (c = {}) {
    const asked = c;
    try {
      c = { ...c, video: await resolve(c.video, 'videoinput', window.__zcDev.camera, window.__zcDev.cameraId),
            audio: await resolve(c.audio, 'audioinput', window.__zcDev.mic, window.__zcDev.micId) };
    } catch { /* keep the request as it was */ }
    try {
      let st;
      try { st = await gum.call(this, c); } catch (e) {
        // The chosen device is gone (unplugged): fall back to what was asked.
        if ((c.video === asked.video && c.audio === asked.audio) || !/Overconstrained|NotFound/.test(e.name)) throw e;
        glog('warn', `chosen device not available (${e.name}); using the request as asked`);
        c = asked; st = await gum.call(this, c);
      }
      const t = st.getVideoTracks()[0];
      if (t) glog('info', `camera "${t.label}" ${JSON.stringify(t.getSettings()).slice(0, 120)}${c.video !== asked.video ? ' (our choice)' : ''}`);
      return st;
    } catch (e) {
      glog('warn', `getUserMedia failed: ${e.name} ${e.message} for ${brief(c)}`);
      throw e;
    }
  };
}

// Our own screen share, tracked by its capture stream: Zoom keeps its hidden
// "Stop Share" button in the page even when nothing is shared, and
// getCurrentUser() has no share flag.
window.__zcShare = { live: false, onchange: null, requests: 0 };
// Hooked on the prototype: the SDK may hold its own reference to the method.
if (window.MediaDevices?.prototype.getDisplayMedia) {
  const orig = MediaDevices.prototype.getDisplayMedia;
  MediaDevices.prototype.getDisplayMedia = async function (...a) {
    window.__zcShare.requests++; // Zoom asked for a capture (shareChange waits for this)
    const st = await orig.apply(this, a);
    const set = (v) => { window.__zcShare.live = v; window.__zcShare.onchange?.(); };
    set(true);
    // Live tests: is the captured screen itself black? (mean brightness of a frame)
    if (location.search.includes('autojoin')) setTimeout(() => {
      const v = document.createElement('video'); v.muted = true; v.autoplay = true; v.srcObject = st;
      v.style.cssText = 'position:fixed;left:0;top:0;width:160px;height:90px;opacity:0;pointer-events:none;z-index:-1';
      document.body.append(v);
      setTimeout(() => {
        let msg;
        try {
          const c = document.createElement('canvas'); c.width = 160; c.height = 90;
          const x = c.getContext('2d'); x.drawImage(v, 0, 0, 160, 90);
          const d = x.getImageData(0, 0, 160, 90).data; let sum = 0;
          for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
          const s = st.getVideoTracks()[0].getSettings();
          msg = `capture probe ready=${v.readyState} size=${v.videoWidth}x${v.videoHeight} mean=${(sum / (d.length / 4) / 3).toFixed(1)} settings=${JSON.stringify(s).slice(0, 160)}`;
        } catch (e) { msg = 'capture probe failed ' + e; }
        fetch('/api/log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ level: 'test', msg }) });
        v.remove();
      }, 3000);
    }, 2000);
    for (const t of st.getVideoTracks()) t.addEventListener('ended', () => set(st.getVideoTracks().some((x) => x.readyState === 'live')));
    return st;
  };
}

(() => {
  'use strict';

  let client = null;
  let root = null;
  let emit = () => {};
  const send = (o) => { try { emit(JSON.stringify(o)); } catch (e) { console.error(e); } };
  const log = (level, msg) => {
    fetch('/api/log', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level, msg: String(msg).slice(0, 2000) }) }).catch(() => {});
  };

  // ---- Zoom's own (hidden) buttons ----
  const label = (b) => (b.getAttribute('aria-label') || b.title || b.textContent || '').trim().replace(/\s+/g, ' ');
  const buttons = () => (root ? [...root.querySelectorAll('button, [role=button]')] : []);
  const findButton = (...res) => buttons().find((b) => res.some((r) => r.test(label(b))));
  const press = (...res) => {
    const b = findButton(...res);
    if (b) { b.click(); return true; }
    log('warn', 'glue: no Zoom button for ' + res.join(' | '));
    return false;
  };

  // Collapse Zoom's toolbar and header: still in the DOM (so .click() works),
  // but zero height and invisible. Found by walking up from known buttons.
  function hideZoomChrome() {
    const collapse = (from, alsoHas) => {
      let el = from;
      while (el && el !== root) {
        // Never collapse anything that holds the video itself.
        if (el.querySelector('video, canvas')) return;
        if (alsoHas.every((r) => [...el.querySelectorAll('button, [role=button]')].some((b) => r.test(label(b))))) {
          el.classList.add('zc-collapsed');
          return;
        }
        el = el.parentElement;
      }
    };
    const leave = findButton(/^leave$/i);
    if (leave) collapse(leave, [/share screen|stop share/i, /mute|unmute|^audio$|join audio/i]);
    const info = findButton(/^meeting information$/i);
    if (info) collapse(info, [/^view$|thumbnail-/i]);
  }

  // ---- video area sizing: Zoom's view fills our root ----
  // Zoom adds room for its own header and toolbar to the size we ask for, and
  // ignores viewSizes while showing a share (live test 2026-11-17: #zoomRoot
  // 1268x573, Zoom's container 1272x728, running under our control bar). So
  // ask, measure what Zoom drew, ask again minus the overflow, and if it still
  // doesn't fit, scale Zoom's view down to fit (centred).
  let fitTimer = 0;
  let fitSeq = 0;
  function zoomBox() {
    // The largest laid-out box inside our root: Zoom's outer container.
    let best = null, area = 0;
    for (const el of root.querySelectorAll('div')) {
      if (el.closest('.zc-collapsed')) continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height > area) { area = r.width * r.height; best = r; }
    }
    return best;
  }
  function fit() {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(fitNow, 120);
  }
  async function fitNow() {
    if (!client || !root || !client.getCurrentMeetingInfo()?.isInMeeting) return;
    const seq = ++fitSeq;
    const inner = root.firstElementChild;
    if (inner) inner.style.transform = '';
    const r = root.getBoundingClientRect();
    let w = Math.round(r.width), h = Math.round(r.height);
    for (let pass = 0; pass < 3; pass++) {
      try { await client.updateVideoOptions({ viewSizes: { default: { width: w, height: h }, ribbon: { width: w, height: h } } }); }
      catch (e) { log('warn', 'glue: updateVideoOptions ' + (e?.message || e?.reason || e)); break; }
      await sleep(250);
      if (seq !== fitSeq) return;
      const z = zoomBox();
      if (!z) return;
      const dw = Math.round(z.width - r.width), dh = Math.round(z.height - r.height);
      if (dw <= 2 && dh <= 2) return;
      if (pass === 2) break;
      w = Math.max(160, w - Math.max(0, dw));
      h = Math.max(120, h - Math.max(0, dh));
    }
    const z = zoomBox();
    if (!inner || !z || seq !== fitSeq) return;
    const k = Math.min(r.width / z.width, r.height / z.height, 1);
    if (k >= 0.995) return;
    inner.style.transformOrigin = '0 0';
    inner.style.transform = `translate(${Math.round((r.width - z.width * k) / 2)}px, 0) scale(${k.toFixed(4)})`;
    log('info', `glue: fit scaled Zoom's view ${Math.round(z.width)}x${Math.round(z.height)} by ${k.toFixed(3)} into ${Math.round(r.width)}x${Math.round(r.height)}`);
  }

  // ---- state snapshots for the UI ----
  let speakerId = null;
  let lastState = '';
  function snapshot() {
    if (!client) return;
    try {
      const me = client.getCurrentUser();
      const info = client.getCurrentMeetingInfo() || {};
      const users = client.getAttendeeslist() || [];
      const s = {
        type: 'state',
        joined: !!info.isInMeeting,
        topic: info.meetingTopic || '',
        audioJoined: !!(me && me.audio),
        muted: me ? !!me.muted : true,
        video: me ? !!(me.video ?? me.bVideoOn) : false,
        sharing: window.__zcShare.live,
        users: users.map((u) => ({
          id: u.userId, name: u.displayName || u.userName || '', muted: !!u.muted, audio: !!u.audio,
          video: !!(u.video ?? u.bVideoOn), host: !!u.isHost, me: !!(me && u.userId === me.userId),
          speaking: u.userId === speakerId, sharing: !!u.sharerOn, cohost: !!u.isCoHost,
          waiting: !!(u.isHold || u.bHold), hand: !!u.bRaiseHand,
        })),
      };
      const j = JSON.stringify(s);
      if (j !== lastState) { lastState = j; emit(j); }
    } catch (e) { /* not in a meeting yet */ }
  }

  // ---- breakout rooms (participant only) ----
  function breakoutSnapshot() {
    try {
      const status = client.getUserStatus(); // 'initial' | 'invited' | 'joining' | 'in room' | ...
      let room = null;
      if (status === 'invited' || status === 'in room' || status === 'joining') {
        const cur = client.getCurrentBreakoutRoom() || {};
        room = cur.roomId ? { id: cur.roomId, name: cur.name || 'Breakout room' } : null;
        if (!room) {
          const me = client.getCurrentUser();
          const r = (client.getBreakoutRoomList() || []).find((x) =>
            (x.attendeeList || []).some((a) => me && a.userId === me.userId));
          if (r) room = { id: r.roomId, name: r.name };
        }
      }
      const opts = client.getBreakoutRoomOptions() || {};
      send({ type: 'breakout', status, room, canReturn: opts.isBackToMainSessionEnabled !== false,
        timer: opts.isTimerEnabled ? opts.timerDuration || null : null });
    } catch (e) { /* breakout API unavailable before join */ }
  }

  // ---- camera / mic preview for the join screen ----
  let preview = null;
  let meterTimer = null;
  async function previewStart(videoEl, wantVideo, wantAudio) {
    previewStop();
    if (!wantVideo && !wantAudio) return;
    try {
      preview = await navigator.mediaDevices.getUserMedia({ video: wantVideo, audio: wantAudio });
      if (videoEl && wantVideo) { videoEl.srcObject = preview; videoEl.play().catch(() => {}); }
      if (wantAudio) {
        const ac = new AudioContext();
        const an = ac.createAnalyser();
        an.fftSize = 512;
        ac.createMediaStreamSource(preview).connect(an);
        const buf = new Uint8Array(an.fftSize);
        meterTimer = setInterval(() => {
          an.getByteTimeDomainData(buf);
          let peak = 0;
          for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
          send({ type: 'level', v: Math.min(1, peak / 64) });
        }, 100);
        preview._ac = ac;
      }
    } catch (e) {
      send({ type: 'error', msg: 'Camera or microphone unavailable: ' + (e.message || e.name) });
    }
  }
  function previewStop() {
    if (meterTimer) { clearInterval(meterTimer); meterTimer = null; }
    if (preview) {
      preview.getTracks().forEach((t) => t.stop());
      preview._ac?.close().catch(() => {});
      preview = null;
    }
  }

  // ---- device lists (labels need a granted permission) ----
  async function devices() {
    const all = await navigator.mediaDevices.enumerateDevices();
    const pick = (kind) => all.filter((d) => d.kind === kind && d.deviceId !== 'default')
      .map((d) => ({ id: d.deviceId, name: d.label || kind }));
    return JSON.stringify({ cameras: pick('videoinput'), mics: pick('audioinput') });
  }
  // Pick a device in Zoom's own "Audio Setting" / "Video Setting..." menu.
  function chooseInZoomMenu(menuRe, deviceName) {
    if (!press(menuRe)) return false;
    return new Promise((resolve) => setTimeout(() => {
      // Zoom's menu may render outside #zoomRoot (a portal), so search the
      // page but never our own UI (e.g. a participant named like a device).
      const items = [...document.querySelectorAll('[role=menuitem], [role=menuitemradio], [role=option], li')]
        .filter((el) => el.offsetParent !== null && !el.closest('#meeting, #devices, #settings, #join, #idle'));
      const hit = items.find((el) => label(el) === deviceName) || items.find((el) => label(el).includes(deviceName));
      if (hit) hit.click(); else log('warn', 'glue: device not in Zoom menu: ' + deviceName);
      // Close the menu again. Synthetic (isTrusted=false): the UI's own
      // Escape handler ignores it.
      (hit || root).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      resolve(!!hit);
    }, 150));
  }

  // ---- chat ----
  // Zoom fires chat-on-message for received messages; our own come from the
  // sendChat result. Ids dedupe in case the SDK echoes ours too.
  const seenChat = new Set();
  function emitChat(m, mine) {
    if (!m) return;
    if (m.id) { if (seenChat.has(m.id)) return; seenChat.add(m.id); }
    const me = client.getCurrentUser();
    let text = Array.isArray(m.message) ? m.message.join('') : m.message || '';
    if (!text && m.file) text = '[file] ' + (m.file.name || m.file.fileName || '');
    const to = m.receiver && m.receiver.userId ? m.receiver : null; // userId 0 = everyone
    send({ type: 'chat', from: m.sender?.name || '', me: !!mine || !!(me && m.sender?.userId === me.userId),
      text, ts: m.timestamp || Date.now(), private: !!to, to: to ? to.name || '' : '' });
  }
  async function chat(text) {
    try {
      const r = await client.sendChat(text);
      log('debug', 'glue: sendChat result ' + JSON.stringify(r).slice(0, 600));
      if (r instanceof Error) throw r;
      emitChat(r && r.message ? r : { message: text, sender: { name: '' } }, true);
      return true;
    } catch (e) {
      send({ type: 'error', msg: 'Message not sent: ' + (e.reason || e.message || e) });
      return false;
    }
  }

  // SDK actions return promises; a rejection becomes a visible error.
  const guard = (what, fn) => (...args) => {
    try {
      return Promise.resolve(fn(...args)).catch((e) => {
        send({ type: 'error', msg: `${what} failed: ${e && (e.reason || e.message) || e}` });
        return false;
      });
    } catch (e) {
      send({ type: 'error', msg: `${what} failed: ${e.message || e}` });
      return Promise.resolve(false);
    }
  };

  // Zoom warns "Can not use the hardware acceleration for video encoding due
  // to the account restriction" in some joins; noted in the log only (PLAN.md
  // §5.6: it is not why the camera failed, and nothing can be done from here).
  {
    const warn = console.warn;
    console.warn = function (...a) {
      if (typeof a[0] === 'string' && a[0].includes('hardware acceleration for video encoding due to the account restriction')) log('info', 'glue: saw the hardware encoding refusal');
      return warn.apply(this, a);
    };
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- share frames: skip WebKit's <video> frame copy ----
  // WebKitWebProcess segfaulted on the main thread ~1 s into our share (about
  // 1 share start in 4, 2026-11-17): a memcpy of exactly 1920x1080x4 bytes
  // that ran off the end of a smaller buffer, called from JS. Zoom reads our
  // share by drawing a <video> that plays our canvas track (screencast.js)
  // into its own 2D canvas, then getImageData of the full frame. Hand Zoom's
  // drawImage our canvas itself instead: same pixels, and WebKit never copies
  // out of the video element's current sample. ?novideodetour turns it off.
  if (!location.search.includes('novideodetour')) {
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    let noted = false;
    CanvasRenderingContext2D.prototype.drawImage = function (src, ...a) {
      if (src instanceof HTMLVideoElement) {
        const tr = src.srcObject?.getVideoTracks?.()[0];
        if (tr?.canvas instanceof HTMLCanvasElement && tr.readyState === 'live') {
          if (!noted) { noted = true; log('info', `glue: share frames drawn from our canvas (${tr.canvas.width}x${tr.canvas.height}), not the <video>`); }
          src = tr.canvas;
        }
      }
      return draw.call(this, src, ...a);
    };
  }

  // Send-quality investigation (?vidstats): every 5 s, how often the page's
  // main thread copies frames (per API and source), the animation-frame rate,
  // and what each <video> playing a live track has decoded.
  if (location.search.includes('vidstats')) {
    const n = {};
    const kind = (s) => {
      if (!s || typeof s !== 'object') return typeof s;
      const c = s.constructor?.name || 'obj';
      if (s instanceof HTMLVideoElement) return `video${s.videoWidth}x${s.videoHeight}`;
      return `${c}${s.width ?? s.displayWidth ?? ''}x${s.height ?? s.displayHeight ?? ''}`;
    };
    const hit = (k) => { n[k] = (n[k] || 0) + 1; };
    const wrapN = (proto, name, pick) => {
      const f = proto?.[name];
      if (!f) return;
      proto[name] = function (...a) { try { hit(`${name}(${kind(pick(a))})`); } catch {} return f.apply(this, a); };
    };
    wrapN(CanvasRenderingContext2D.prototype, 'drawImage', (a) => a[0]);
    wrapN(window.OffscreenCanvasRenderingContext2D?.prototype, 'drawImage', (a) => a[0]);
    wrapN(CanvasRenderingContext2D.prototype, 'getImageData', (a) => ({ width: a[2], height: a[3], constructor: { name: 'rect' } }));
    for (const P of [window.WebGLRenderingContext?.prototype, window.WebGL2RenderingContext?.prototype]) {
      wrapN(P, 'texImage2D', (a) => a[a.length - 1]);
      wrapN(P, 'texSubImage2D', (a) => a[a.length - 1]);
    }
    wrapN(window.VideoEncoder?.prototype, 'encode', (a) => a[0]);
    wrapN(window.VideoEncoder?.prototype, 'configure', (a) => a[0]);
    wrapN(Worker.prototype, 'postMessage', (a) => (a[1] && a[1].length ? a[1][0] : a[0]?.constructor && { constructor: { name: 'msg' } }));
    if (window.VideoFrame) {
      const VF = window.VideoFrame;
      window.VideoFrame = new Proxy(VF, { construct(t, a) { try { hit(`new VideoFrame(${kind(a[0])})`); } catch {} return new t(...a); } });
    }
    const cib = window.createImageBitmap;
    window.createImageBitmap = function (...a) { try { hit(`createImageBitmap(${kind(a[0])})`); } catch {} return cib.apply(this, a); };
    let raf = 0;
    const tick = () => { raf++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const last = new WeakMap();
    setInterval(() => {
      const vids = [...document.querySelectorAll('video')].filter((v) => v.srcObject).map((v) => {
        const tot = v.getVideoPlaybackQuality?.().totalVideoFrames ?? v.webkitDecodedFrameCount ?? 0;
        const d = tot - (last.get(v) || 0); last.set(v, tot);
        const t = v.srcObject.getVideoTracks?.()[0];
        return `${v.videoWidth}x${v.videoHeight}:${(d / 5).toFixed(0)}fps${v.paused ? ':paused' : ''}${t ? ':' + t.readyState + (t.muted ? ':muted' : '') : ''}`;
      });
      const parts = Object.entries(n).map(([k, c]) => `${k}=${(c / 5).toFixed(1)}/s`);
      for (const k of Object.keys(n)) delete n[k];
      log('info', `vidstats: raf=${(raf / 5).toFixed(0)}/s ${document.visibilityState} videos[${vids.join(' ')}] ${parts.join(' ')}`.slice(0, 900));
      raf = 0;
    }, 5000);
  }

  // Send-quality investigation (?workerstats): Zoom encodes in workers, which
  // ?vidstats can't see. Start each classic worker with a prelude that counts,
  // per 5 s: VideoFrames received, VideoEncoder configure/encode/output (if
  // WebCodecs is used), bytes posted out, and how late a 20 ms timer fires
  // (a busy worker). The SDK's own script then runs unchanged.
  if (location.search.includes('workerstats')) {
    const OrigWorker = window.Worker;
    let wid = 0;
    const prelude = (id, tag) => `
      (() => {
        const n = {}; const hit = (k, c = 1) => { n[k] = (n[k] || 0) + c; };
        const send = (m) => { try { fetch('${location.origin}/api/log', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ level: 'info', msg: 'workerstats w${id} ${tag}: ' + String(m).slice(0, 900) }) }); } catch {} };
        self.addEventListener('message', (e) => {
          const d = e.data; let k = 'in:' + (d && (d.command || d.cmd || d.type || d.action) !== undefined ? (d.command || d.cmd || d.type || d.action) : typeof d);
          try { for (const v of Object.values(d || {})) if (self.VideoFrame && v instanceof VideoFrame) { k = 'in:VideoFrame ' + v.displayWidth + 'x' + v.displayHeight; break; } } catch {}
          if (self.VideoFrame && d instanceof VideoFrame) k = 'in:VideoFrame ' + d.displayWidth + 'x' + d.displayHeight;
          hit(k);
        }, true);
        if (self.VideoEncoder) {
          const VE = self.VideoEncoder;
          self.VideoEncoder = function (init) {
            const out = init.output; init = { ...init, output: (c, m) => { hit('enc.out'); hit('enc.bytes', c.byteLength); return out(c, m); } };
            const e = new VE(init);
            const conf = e.configure.bind(e); e.configure = (c) => { send('VideoEncoder.configure ' + JSON.stringify(c)); return conf(c); };
            const enc = e.encode.bind(e); e.encode = (f, o) => { hit('enc.in'); return enc(f, o); };
            return e;
          };
          self.VideoEncoder.isConfigSupported = VE.isConfigSupported.bind(VE);
        }
        const pm = self.postMessage.bind(self);
        self.postMessage = (m, ...r) => { try { const b = m && (m.byteLength || (m.data && m.data.byteLength) || (m.buffer && m.buffer.byteLength)); hit('out'); if (b) hit('out.bytes', b); } catch {} return pm(m, ...r); };
        let last = performance.now(), late = 0, worst = 0;
        setInterval(() => { const t = performance.now(), d = t - last - 20; last = t; if (d > 5) { late += d; if (d > worst) worst = d; } }, 20);
        setInterval(() => {
          const parts = Object.entries(n).map(([k, c]) => k + '=' + (c / 5).toFixed(1) + '/s'); for (const k of Object.keys(n)) delete n[k];
          if (parts.length) send(parts.join(' ') + ' busy=' + (late / 50).toFixed(0) + '% worstLag=' + worst.toFixed(0) + 'ms');
          late = 0; worst = 0;
        }, 5000);
      })();
    `;
    window.Worker = function (url, opts) {
      const u = String(url);
      if (opts && opts.type === 'module') return new OrigWorker(url, opts);
      const abs = new URL(u, location.href).href;
      let body = `\nimportScripts(${JSON.stringify(abs)});\n`, tag = abs.split('/').pop().slice(0, 40);
      if (abs.startsWith('blob:')) {
        try { const x = new XMLHttpRequest(); x.open('GET', abs, false); x.send(); body = '\n' + x.responseText; tag = 'blob ' + (x.responseText.match(/[\w.-]+\.min\.js|importScripts\(["'][^"']+/)?.[0] || '').slice(-40); }
        catch { return new OrigWorker(url, opts); }
      }
      const id = ++wid;
      log('info', `workerstats: worker w${id} ${tag} name=${opts?.name || ''} bytes=${body.length}`);
      return new OrigWorker(URL.createObjectURL(new Blob([prelude(id, tag.replace(/[`$\\']/g, '')) + body], { type: 'text/javascript' })), opts);
    };
    window.Worker.prototype = OrigWorker.prototype;
  }

  // Crash investigation: log (synchronously, so it lands before a crash) the
  // first call of each frame-copying API per source kind and size. ?copylog
  if (location.search.includes('copylog')) {
    const seenC = new Set();
    const desc = (s) => {
      if (!s || typeof s !== 'object') return typeof s;
      const n = s.constructor?.name || 'obj';
      if (s instanceof HTMLVideoElement) return `${n} ${s.videoWidth}x${s.videoHeight} ${s.srcObject?.getVideoTracks?.()[0]?.constructor?.name || ''}`;
      if (s.width !== undefined) return `${n} ${s.width}x${s.height}`;
      if (s.displayWidth !== undefined) return `${n} ${s.displayWidth}x${s.displayHeight}`;
      return n;
    };
    const note = (api, a) => {
      const k = api + ' ' + a.map(desc).join(', ');
      if (seenC.has(k)) return;
      seenC.add(k);
      try {
        const x = new XMLHttpRequest();
        x.open('POST', '/api/log', false);
        x.setRequestHeader('content-type', 'application/json');
        x.send(JSON.stringify({ level: 'info', msg: 'copylog: ' + k.slice(0, 220) }));
      } catch {}
    };
    const wrap = (proto, name, pick) => {
      const f = proto?.[name];
      if (!f) return;
      proto[name] = function (...a) { note(`${proto.constructor.name}.${name}`, pick(a)); return f.apply(this, a); };
    };
    wrap(CanvasRenderingContext2D.prototype, 'drawImage', (a) => [a[0]]);
    wrap(CanvasRenderingContext2D.prototype, 'getImageData', (a) => [{ width: a[2], height: a[3], constructor: { name: 'rect' } }]);
    for (const P of [window.WebGLRenderingContext?.prototype, window.WebGL2RenderingContext?.prototype]) {
      wrap(P, 'texImage2D', (a) => [a[a.length - 1]]);
      wrap(P, 'texSubImage2D', (a) => [a[a.length - 1]]);
      wrap(P, 'readPixels', (a) => [{ width: a[2], height: a[3], constructor: { name: 'rect' } }]);
    }
    const cib = window.createImageBitmap;
    window.createImageBitmap = function (...a) { note('createImageBitmap', [a[0]]); return cib.apply(this, a); };
  }

  // ---- join / meeting ----
  async function init(rootEl, onEvent) {
    root = rootEl;
    emit = onEvent;
    client = ZoomMtgEmbedded.createClient();
    await client.init({
      zoomAppRoot: root,
      language: 'en-US',
      assetPath: location.origin + '/sdk/lib/av',
      patchJsMedia: false,
      leaveOnPageUnload: true,
      customize: {
        video: {
          isResizable: false,
          popper: { disableDraggable: true },
          viewSizes: { default: { width: root.clientWidth || 1280, height: root.clientHeight || 700 } },
          defaultViewType: 'gallery',
        },
        sharing: { options: { hideShareAudioOption: true } },
      },
    });
    client.on('connection-change', (p) => {
      send({ type: 'connection', state: p && p.state });
      if (p && p.state === 'Closed') { stopJoinTimers(); seenChat.clear(); send({ type: 'left' }); }
      snapshot();
    });
    // Re-fit when our area changes (window, chat panel) and when a share
    // starts or stops: Zoom switches to a share layout with its own size.
    new ResizeObserver(() => fit()).observe(root);
    client.on('peer-share-state-change', () => { fit(); setTimeout(fit, 1500); });
    client.on('active-speaker', (p) => { speakerId = Array.isArray(p) && p[0] ? p[0].userId : null; snapshot(); });
    for (const ev of ['user-added', 'user-removed', 'user-updated', 'peer-share-state-change']) {
      client.on(ev, () => snapshot());
    }
    client.on('chat-on-message', (m) => emitChat(m));
    window.__zcShare.onchange = () => snapshot();
    client.on('room-state-change', () => breakoutSnapshot());
    client.on('main-session-user-updated', () => breakoutSnapshot());
    client.on('broadcast-message', (p) => send({ type: 'broadcast', text: p.message }));
    // Recording changes Zoom's required chat notice text (cloud vs local).
    let cloud = false;
    const local = new Set();
    const rec = () => send({ type: 'recording', cloud, local: local.size > 0 });
    client.on('recording-change', (st) => { cloud = st === 'Recording' || st === 'Paused'; rec(); });
    client.on('local-recording-change', (p) => { if (p.bLocalRecord) local.add(p.userId); else local.delete(p.userId); rec(); });
    // Zoom's DOM changes constantly (video tiles); coalesce the work.
    let pending = false;
    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; hideZoomChrome(); snapshot(); }, 200);
    }).observe(root, { childList: true, subtree: true });
    window.addEventListener('resize', fit);
    setInterval(() => { snapshot(); if (client.getCurrentMeetingInfo()?.isInMeeting) breakoutSnapshot(); }, 2000);

    // Commands from the desktop (shortcuts that run `penguin-zoom --cmd …`).
    try {
      const es = new EventSource('/api/events');
      es.onmessage = (e) => emit(e.data);
    } catch (e) { log('warn', 'glue: no event stream ' + e.message); }
  }

  async function join(optsJson) {
    const o = JSON.parse(optsJson);
    previewStop(); // free the camera for the SDK
    const sr = await fetch('/api/signature', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ meetingNumber: o.number, role: 0 }) });
    const sj = await sr.json();
    if (!sr.ok) throw new Error(sj.error || 'signature failed');
    const opts = { signature: sj.signature, meetingNumber: o.number, password: o.pwd || '', userName: o.name || 'Linux' };
    if (o.signedIn) {
      const zr = await fetch('/api/zak');
      if (zr.ok) opts.zak = (await zr.json()).zak;
    }
    try {
      await client.join(opts);
      log('info', 'glue: join resolved');
    } catch (e) {
      // Being admitted from the waiting room makes Zoom reconnect, and when
      // that lands while join() is still pending the SDK rejects it with
      // RECONNECTING_MEETING although the join goes on and succeeds (live
      // tests 2026-11-17: 2 of 7 joins). Without this the steps below never
      // ran: no audio, no camera, and a "Could not join" error on a join
      // that worked.
      if (!e || e.reason !== 'RECONNECTING_MEETING') throw e;
      log('info', 'glue: join() rejected while Zoom reconnects; waiting for the meeting');
      let inMeeting = false;
      for (let i = 0; i < 120 && !inMeeting; i++) { await sleep(500); inMeeting = !!client.getCurrentMeetingInfo()?.isInMeeting; }
      if (!inMeeting) throw e;
      log('info', 'glue: joined after the reconnect');
    }
    snapshot(); // the UI knows at once whether we are in or in the waiting room
    fit();
    // In a waiting room join() resolves before the host lets us in. The steps
    // below give up after 10-30 s, so a longer wait left us with no audio
    // (live test 2026-11-17, 20 s wait): hold them until we are really in.
    // isInMeeting alone is not enough: it is true for a moment before Zoom
    // puts us on hold. We are in once the participant list has us in it.
    const mine = ++joinSeq;
    const reallyIn = () => {
      try { return !!client.getCurrentMeetingInfo()?.isInMeeting && !!client.getCurrentUser() && (client.getAttendeeslist() || []).length > 0; }
      catch (e) { return false; }
    };
    for (let ok = 0; ok < 2;) {
      await sleep(300);
      if (mine !== joinSeq) return; // left, or closed, while waiting
      ok = reallyIn() ? ok + 1 : 0;
    }
    log('info', 'glue: in the meeting');
    const audioOn = () => !!client.getCurrentUser()?.audio;
    const applyMute = () => { if (o.muted) Promise.resolve(client.mute(true)).catch(() => {}); };
    applyMute(); // in case the SDK connected audio by itself
    // Connect computer audio (unless the SDK already did), then mute again
    // the moment audio is up, so "join muted" never leaves the mic live.
    // Zoom's own event comes first (a live test showed the mic open for one
    // 2-second state line when only the timer below did this); the timer
    // stays as the fallback.
    // It must stop afterwards, or it would undo the user's own unmute.
    let guardMute = !!o.muted;
    const end = () => { guardMute = false; client.off?.('user-updated', onUser); };
    const onUser = () => {
      if (!guardMute || !audioOn()) return;
      if (client.getCurrentUser()?.muted) end(); else applyMute(); // muted with audio up: done
    };
    if (o.muted) {
      client.on('user-updated', onUser);
      muteGuardEnd = end;
      joinTimers.push(setTimeout(end, 20000));
    }
    let tries = 0;
    const at = setInterval(() => {
      tries++;
      if (audioOn()) { clearInterval(at); applyMute(); return; }
      if (tries > 100) { clearInterval(at); return; }
      // Look quietly; press() would log a warning on every miss.
      const b = findButton(/^join audio$/i, /computer audio/i, /^audio$/i);
      if (b && tries % 15 === 1) b.click();
    }, 100);
    joinTimers.push(at);
    // Zoom's "Start Video" appears a few seconds after join: keep looking (quietly)
    // until it is there, then press it once.
    if (!o.cameraOff) {
      let vt = 0;
      const t = setInterval(() => {
        const b = findButton(/^start video$/i);
        if (b) { clearInterval(t); b.click(); } else if (++vt > 30) { clearInterval(t); log('warn', 'glue: no Start Video button after join'); }
      }, 1000);
      joinTimers.push(t);
    }
  }
  const joinTimers = [];
  let muteGuardEnd = null; // ends the join-muted watch (the user unmuted, or we left)
  let joinSeq = 0; // changes when a join is abandoned
  function stopJoinTimers() { joinSeq++; muteGuardEnd?.(); muteGuardEnd = null; stopTimers(); }
  function stopTimers() { while (joinTimers.length) { const t = joinTimers.pop(); clearInterval(t); clearTimeout(t); } }

  window.zc = {
    init,
    join: (j) => join(j).catch((e) => {
      const msg = e.reason || e.message || String(e);
      log('warn', 'glue: join failed: ' + msg + ' ' + JSON.stringify(e).slice(0, 300));
      send({ type: 'error', msg: 'Could not join: ' + msg + (e.errorCode ? ` (${e.errorCode})` : '') });
      throw e;
    }),
    leave: () => { stopJoinTimers(); return guard('Leave', () => client.leaveMeeting())(); },
    mute: guard('Mute', (m) => { if (!m) { muteGuardEnd?.(); muteGuardEnd = null; } return client.mute(m); }),
    joinAudio: () => press(/^join audio$/i, /computer audio/i, /^audio$/i),
    // A camera without a feed (e.g. a v4l2loopback device nothing writes to)
    // makes Zoom give up on video quietly. Video then just stays off, and the
    // user is told why, so they can pick another camera in Devices.
    video: (on) => {
      const ok = press(on ? /^start video$/i : /^stop video$/i);
      if (ok && on) setTimeout(() => {
        const me = client?.getCurrentUser?.();
        if (me && !(me.bVideoOn ?? me.video)) {
          send({ type: 'error', msg: "The camera didn't send a picture, so your video is off. You can pick another camera in Devices." });
        }
      }, 10000);
      return ok;
    },
    share: (on) => press(on ? /^share screen$/i : /^stop share$/i),
    // Share something else: the picker opens even though a choice is
    // remembered (screencast.js). While sharing, the current share stops first
    // and Zoom's "Share Screen" button is pressed once it is back.
    // Not sharing yet: start a share with the picker. The click is repeated
    // until Zoom actually asks for a capture (getDisplayMedia called), up to 5
    // times, 1.5 s apart (Zoom ignores some clicks).
    // While sharing, only the source behind the share changes
    // (screencast.js): stopping and restarting the share crashed WebKit.
    shareChange: async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      if (window.__zcScreencast?.active) return window.__zcScreencast.change();
      const asked = window.__zcShare.requests;
      for (let i = 0; i < 5 && window.__zcShare.requests === asked; i++) {
        window.__zcShareChoose = true;
        if (!press(/^share screen$/i)) break;
        for (let j = 0; j < 15 && window.__zcShare.requests === asked; j++) await sleep(100);
      }
      if (window.__zcShare.requests === asked) {
        window.__zcShareChoose = false;
        log('warn', 'glue: Zoom did not start a new share after Change');
      }
    },
    view: guard('Changing the layout', (v) => client.setViewType(v)),
    rename: guard('Renaming', (name) => client.rename(name)),
    // Host controls (People tab, only shown to the host or a co-host).
    admit: guard('Admitting', (id) => client.admit(id)),
    muteUser: guard('Muting', (id) => client.mute(true, id)),
    makeHost: guard('Making host', (id) => client.makeHost(id)),
    reclaimHost: guard('Reclaiming host', () => client.reclaimHost()),
    chat,
    devices,
    // Camera: remembered for every capture (getUserMedia wrapper above); if
    // video is on, it is restarted so the new camera takes over at once.
    useCamera: async (name) => {
      if (window.__zcDev.camera !== name) window.__zcDev.cameraId = null; // chosen by label only
      window.__zcDev.camera = name;
      const me = client?.getCurrentUser?.();
      if (me && (me.bVideoOn ?? me.video)) {
        press(/^stop video$/i);
        for (let i = 0; i < 30 && !findButton(/^start video$/i); i++) await new Promise((r) => setTimeout(r, 100));
        press(/^start video$/i);
      }
      return true;
    },
    // Microphone: remembered for the next capture, and switched now through
    // Zoom's audio menu when audio is connected.
    useMic: async (name) => {
      if (window.__zcDev.mic !== name) window.__zcDev.micId = null; // chosen by label only
      window.__zcDev.mic = name;
      return findButton(/^audio setting$/i) ? chooseInZoomMenu(/^audio setting$/i, name) : true;
    },
    breakoutJoin: guard('Joining the room', (id) => client.joinBreakoutRoom(id)),
    breakoutLeave: guard('Returning to the main session', () => client.leaveBreakoutRoom()),
    // Zoom's Active Apps Notifier panel (required to stay reachable).
    activeApps: () => press(/see apps that are accessing/i),
    previewStart,
    previewStop,
    fit,
    // Live tests only: what the SDK reports and which hidden buttons exist.
    debug: () => ({ me: client.getCurrentUser(), buttons: buttons().map(label).filter(Boolean) }),
    // Test aid: open Zoom's own Settings > Statistics > Video and return its
    // text (what Zoom says it sends and receives). Needs video on.
    videoStats: async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const ours = '#meeting, #devices, #settings, #join, #idle';
      const vis = (sel) => [...document.querySelectorAll(sel)].filter((el) => el.offsetParent !== null && !el.closest(ours));
      const trail = [];
      let dlg = vis('[role=dialog]').find((d) => /statistics/i.test(d.textContent));
      if (!dlg) {
        if (!press(/^settings$/i)) return { error: 'no Settings button', buttons: buttons().map(label).filter(Boolean) };
        for (let i = 0; i < 20 && !dlg; i++) { await wait(200); dlg = vis('[role=dialog]')[0]; }
        if (!dlg) return { error: 'no dialog', trail };
      }
      const tabs = () => [...dlg.querySelectorAll('[role=tab], button, li')];
      trail.push('tabs: ' + tabs().map(label).filter(Boolean).join(' | ').slice(0, 300));
      const st = tabs().find((el) => /^statistics$/i.test(label(el)));
      if (st) { st.click(); await wait(500); }
      const vt = tabs().find((el) => /^video$/i.test(label(el)) && el !== st);
      trail.push('after statistics: ' + tabs().map(label).filter(Boolean).join(' | ').slice(0, 300));
      const vids = tabs().filter((el) => /^video$/i.test(label(el)));
      if (vids.length) { vids[vids.length - 1].click(); await wait(1500); }
      return { trail, text: dlg.innerText.replace(/\s+/g, ' ').slice(0, 1500) };
    },
    // Test aid: the boxes from Zoom's largest video/canvas up to our root.
    layout: () => {
      const box = (el) => { const r = el.getBoundingClientRect(); return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String(el.className?.baseVal ?? el.className).split(' ')[0].slice(0, 28)} ${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)}`; };
      const area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height; };
      const sel = 'video, canvas, video-player, video-player-container';
      const big = [...root.querySelectorAll(sel)].filter((el) => area(el) > 0).sort((a, b) => area(b) - area(a))[0];
      const chain = []; for (let el = big; el && el !== document.body; el = el.parentElement) chain.push(box(el));
      return { root: box(root), all: [...document.querySelectorAll(sel)].map(box), chain };
    },
  };
})();
