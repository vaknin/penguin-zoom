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
window.__zcDev = { camera: null, mic: null }; // chosen device labels
{
  const gum = MediaDevices.prototype.getUserMedia;
  const resolve = async (c, kind, want) => {
    if (!c) return c;
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default');
    if (!devs.length || !devs[0].label) return c; // no labels before the first grant
    const o = typeof c === 'object' ? { ...c } : {};
    const askedId = o.deviceId?.exact ?? o.deviceId?.ideal ?? o.deviceId;
    const asked = devs.find((d) => d.deviceId === askedId);
    const use = want ? devs.find((d) => d.label === want) : null;
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
      c = { ...c, video: await resolve(c.video, 'videoinput', window.__zcDev.camera),
            audio: await resolve(c.audio, 'audioinput', window.__zcDev.mic) };
    } catch { /* keep the request as it was */ }
    try {
      const st = await gum.call(this, c);
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
  function fit() {
    if (!client || !root || !client.getCurrentMeetingInfo()?.isInMeeting) return;
    const r = root.getBoundingClientRect();
    try {
      client.updateVideoOptions({
        viewSizes: { default: { width: Math.round(r.width), height: Math.round(r.height) } },
      });
    } catch (e) { log('warn', 'glue: updateVideoOptions ' + e.message); }
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

    // Commands from the desktop (Hyprland binds call `penguin-zoom --cmd …`).
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
    await client.join(opts);
    fit();
    const audioOn = () => !!client.getCurrentUser()?.audio;
    const applyMute = () => { if (o.muted) Promise.resolve(client.mute(true)).catch(() => {}); };
    applyMute(); // in case the SDK connected audio by itself
    // Connect computer audio (unless the SDK already did), then mute again
    // the moment audio is up, so "join muted" never leaves the mic live.
    let tries = 0;
    const at = setInterval(() => {
      tries++;
      if (audioOn()) { clearInterval(at); applyMute(); return; }
      if (tries > 20) { clearInterval(at); return; }
      // Look quietly; press() would log a warning on every miss.
      const b = findButton(/^join audio$/i, /computer audio/i, /^audio$/i);
      if (b && tries % 3 === 1) b.click();
    }, 500);
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
  function stopJoinTimers() { while (joinTimers.length) { const t = joinTimers.pop(); clearInterval(t); clearTimeout(t); } }

  window.zc = {
    init,
    join: (j) => join(j).catch((e) => {
      const msg = e.reason || e.message || String(e);
      send({ type: 'error', msg: 'Could not join: ' + msg + (e.errorCode ? ` (${e.errorCode})` : '') });
      throw e;
    }),
    leave: () => { stopJoinTimers(); return guard('Leave', () => client.leaveMeeting())(); },
    mute: guard('Mute', (m) => client.mute(m)),
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
  };
})();
