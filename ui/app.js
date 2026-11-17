// The app's interface (mockup v2): join screen, in-meeting controls, devices,
// chat/people, breakout invitations and settings. Plain DOM, no framework.
// Talks to Zoom only through window.zc (web/glue.js) and to the Rust side
// through the local /api endpoints.

const $ = (id) => document.getElementById(id);
const body = document.body;
const chatEmpty = $('chatEmpty');

// ---------- icons (stroke paths, 24×24) ----------
const ICONS = {
  mic: 'M9 6a3 3 0 0 1 6 0v5a3 3 0 0 1-6 0zM5 11a7 7 0 0 0 14 0M12 18v3',
  micOff: 'M9 9v2a3 3 0 0 0 5.1 2.1M15 9.3V6a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 11.5 5.4M12 18v3M3 3l18 18',
  video: 'M2 9a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3zM16 10l6-3v10l-6-3',
  videoOff: 'M16 16v-1l6 3V7l-6 3V9a3 3 0 0 0-3-3H9M5 6a3 3 0 0 0-3 3v6a3 3 0 0 0 3 3h8M3 3l18 18',
  share: 'M2 6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2zM8 21h8M12 17v4M9 10l3-3 3 3M12 7v6',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
  speaker: 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM4 21h4M10 21h4M16 21h4',
  gallery: 'M3 4h7v7H3zM14 4h7v7h-7zM3 15h7v6H3zM14 15h7v6h-7z',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M16 4v4M8 10v4M18 16v4',
  gear: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM15 12a3 3 0 1 1-6 0a3 3 0 1 1 6 0z', // Lucide 'settings' (ISC)
  leave: 'M10 17l5-5-5-5M15 12H3M14 3h4a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3h-4',
  x: 'M6 6l12 12M18 6L6 18',
  send: 'M5 12h14M13 6l6 6-6 6',
  check: 'M5 12l5 5L20 7',
  swap: 'M4 8h13M13 4l4 4-4 4M20 16H7M11 12l-4 4 4 4',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8h.01',
  apps: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
};
function setIcon(svg, name) {
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.innerHTML = `<path d="${ICONS[name]}"></path>`;
  svg.dataset.icon = name;
}
const iconEl = (name, cls = '') => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('class', 'icon ' + cls);
  s.setAttribute('aria-hidden', 'true');
  setIcon(s, name);
  return s;
};
document.querySelectorAll('svg[data-icon]').forEach((s) => setIcon(s, s.dataset.icon));

// ---------- state ----------
const S = {
  screen: 'idle',
  launch: null, // { number, pwd, link }
  settings: { style: 'standard', joinMuted: true, joinCameraOff: false, hideIdle: true, name: '', speakerId: null },
  account: { signedIn: false, user: null, configured: false },
  joinMic: true,
  joinCam: true,
  meet: { joined: false, topic: '', muted: true, video: false, sharing: false, users: [] },
  view: 'gallery',
  panel: null, // 'chat' | 'people'
  unread: 0,
  chatCount: 0,
  devicesOpen: false,
  dev: { cams: [], mics: [], spk: [], cam: null, mic: null },
  breakout: { status: 'initial', room: null, canReturn: true },
  inviteDismissed: null,
  error: null,
  joining: false,
};

const api = async (path, opts) => {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.status === 204 ? null : r.json();
};
// Never write settings we failed to load (that would wipe the saved ones).
let settingsLoaded = false;
const putSettings = () => !settingsLoaded ? Promise.resolve() : api('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(S.settings) }).catch(() => {});

// ---------- links ----------
// Only for ?m=<link> (development); real links are parsed by the server.
function parseLink(raw) {
  raw = (raw || '').trim();
  if (!raw) return null;
  let number = '', pwd = '';
  if (/^[\d\s-]{9,13}$/.test(raw)) number = raw.replace(/\D/g, '');
  else {
    try {
      const u = new URL(raw.replace(/^zoommtg:/, 'https:'));
      pwd = u.searchParams.get('pwd') || '';
      const m = u.pathname.match(/\/(?:j|wc\/join|wc|s)\/(\d+)/);
      number = (m ? m[1] : u.searchParams.get('confno') || '').replace(/\D/g, '');
    } catch { return null; }
  }
  return number.length >= 9 ? { number, pwd, link: raw } : null;
}
const fmtNumber = (n) => n.length === 11 ? `${n.slice(0, 3)} ${n.slice(3, 7)} ${n.slice(7)}`
  : n.length === 10 ? `${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}` : n;

function openLink(l) {
  if (!l) return;
  if (S.screen === 'meeting') { showError('Leave this meeting first to open another link'); return; }
  S.launch = l;
  go('join');
}

// ---------- screens ----------
function go(screen) {
  S.screen = screen;
  body.dataset.screen = screen;
  closeDevices();
  if (screen === 'join') renderJoin();
  else zc.previewStop();
  if (screen === 'meeting') renderMeeting();
  else { setPanel(null); S.leaveAsk = false; body.classList.remove('idle-hide', 'in-waiting'); }
}

// ---------- join ----------
function renderJoin() {
  $('joinTitle').textContent = S.meet.topic && S.meet.joined ? S.meet.topic
    : (S.launch.host ? 'New meeting ' : 'Meeting ') + fmtNumber(S.launch.number);
  $('joinSub').textContent = S.account.signedIn ? `Signed in${S.account.user ? ' as ' + S.account.user : ''}` : 'Joining as a guest';
  $('joinName').value = $('joinName').value || S.settings.name || '';
  if (!$('joinName').value) $('joinName').focus(); // typing goes to the name, not to shortcuts
  renderJoinToggles();
  startPreview();
}
function renderJoinToggles() {
  const mic = $('joinMic'), cam = $('joinCam');
  mic.setAttribute('aria-pressed', S.joinMic);
  mic.classList.toggle('off', !S.joinMic);
  setIcon(mic.querySelector('svg'), S.joinMic ? 'mic' : 'micOff');
  mic.querySelector('span').textContent = S.joinMic ? 'Mic on' : 'Muted';
  cam.setAttribute('aria-pressed', S.joinCam);
  cam.classList.toggle('off', !S.joinCam);
  setIcon(cam.querySelector('svg'), S.joinCam ? 'video' : 'videoOff');
  cam.querySelector('span').textContent = S.joinCam ? 'Camera on' : 'Camera off';
  $('previewOff').hidden = S.joinCam || S.previewHold;
  $('previewVideo').hidden = !S.joinCam;
}
// ?nomedia (tests): never open the camera or microphone.
const NO_MEDIA = new URLSearchParams(location.search).has('nomedia');
function startPreview() {
  $('previewResume').hidden = !S.previewHold;
  if (NO_MEDIA || S.previewHold) { zc.previewStop(); setLevel(0); return; }
  const v = S.joinCam ? (S.dev.cam ? { deviceId: { exact: S.dev.cam } } : true) : false;
  const a = S.joinMic ? (S.dev.mic ? { deviceId: { exact: S.dev.mic } } : true) : false;
  zc.previewStart($('previewVideo'), v, a);
  if (!S.joinMic) setLevel(0);
}
function setLevel(v) {
  const bars = document.querySelectorAll('.meter i');
  const lit = Math.round(v * bars.length);
  bars.forEach((b, i) => b.classList.toggle('on', i < lit));
}
async function doJoin(e) {
  e?.preventDefault();
  if (S.joining || !S.launch) return;
  const name = $('joinName').value.trim();
  if (!name) { $('joinName').focus(); return; }
  if (name !== S.settings.name) { S.settings.name = name; putSettings(); }
  S.joining = true;
  $('joinBtn').disabled = true;
  $('joinBtn').textContent = 'Joining…';
  try {
    await zc.join(JSON.stringify({
      number: S.launch.number, pwd: S.launch.pwd, name, host: !!S.launch.host,
      muted: !S.joinMic, cameraOff: !S.joinCam, signedIn: S.account.signedIn,
    }));
    S.chatCount = 0; S.unread = 0;
    $('chatList').replaceChildren(chatEmpty);
    go('meeting');
    // A camera/mic picked on the join screen is already the preference
    // (pickCam/pickMic), so Zoom's own captures use it.
  } catch { /* glue already sent the error */ }
  S.joining = false;
  $('joinBtn').disabled = false;
  $('joinBtn').textContent = 'Join';
}

// ---------- meeting ----------
function renderMeeting() {
  const m = S.meet;
  // In the meeting screen but not in the meeting yet: the waiting room.
  // After having been in, the same state means Zoom is reconnecting.
  if (m.joined) S.wasIn = true;
  body.classList.toggle('in-waiting', !m.joined);
  $('waitingTitle').textContent = S.wasIn ? 'Reconnecting…' : 'Waiting for the host to let you in';
  $('waitingTopic').textContent = m.topic || (S.launch ? 'Meeting ' + fmtNumber(S.launch.number) : '');
  const mute = $('btnMute');
  const noAudio = m.joined && !m.audioJoined;
  setIcon(mute.querySelector('svg'), m.muted || noAudio ? 'micOff' : 'mic');
  mute.querySelector('span').textContent = noAudio ? 'Join audio' : m.muted ? 'Unmute' : 'Mute';
  mute.classList.toggle('warn', m.muted || noAudio);
  const vid = $('btnVideo');
  setIcon(vid.querySelector('svg'), m.video ? 'video' : 'videoOff');
  vid.querySelector('span').textContent = m.video ? 'Stop video' : 'Start video';
  const sh = $('btnShare');
  sh.setAttribute('aria-pressed', m.sharing);
  sh.querySelector('span').textContent = m.sharing ? 'Stop share' : 'Share';
  $('btnShareChange').hidden = !m.sharing;
  $('btnChat').setAttribute('aria-pressed', S.panel !== null);
  $('btnChat').querySelector('.dot').hidden = !S.unread;
  const lay = $('btnLayout');
  setIcon(lay.querySelector('svg'), S.view === 'gallery' ? 'speaker' : 'gallery');
  lay.querySelector('span').textContent = S.view === 'gallery' ? 'Speaker' : 'Gallery';
  // keyboard-style status line
  $('kbTopic').textContent = (m.topic || 'meeting').toLowerCase();
  $('kbCount').textContent = m.users.length;
  $('kbView').textContent = S.view;
  $('kbMic').textContent = noAudio ? 'no audio' : m.muted ? 'mic muted' : 'mic on';
  $('kbMic').className = m.muted || noAudio ? 'bad' : 'accent';
  $('kbCam').textContent = m.video ? 'cam on' : 'cam off';
  $('kbChat').textContent = S.unread ? `chat ${S.unread}` : '';
  $('tabPeople').textContent = `People · ${m.users.length}`;
  if (S.panel === 'people') renderPeople();
  renderToast();
}
function renderPeople() {
  if (S.renaming) return; // don't wipe the name field while it's being typed in
  const ul = $('peopleList');
  const meUser = S.meet.users.find((u) => u.me) || {};
  const amHost = !!(meUser.host || meUser.cohost);
  ul.replaceChildren(...S.meet.users.map((u) => {
    const li = document.createElement('li');
    const av = document.createElement('span');
    av.className = 'av';
    av.textContent = (u.name || '?').trim().charAt(0).toUpperCase();
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = u.name + (u.me ? ' (you)' : '');
    li.append(av, nm);
    if (u.me) {
      const b = document.createElement('button');
      b.className = 'link small';
      b.dataset.action = 'rename';
      b.textContent = 'Rename';
      li.append(b);
    }
    const tag = (text) => { const t = document.createElement('span'); t.className = 'tag'; t.textContent = text; li.append(t); };
    if (u.host) tag('host'); else if (u.cohost) tag('co-host');
    if (u.waiting) tag('waiting');
    if (u.sharing) tag('sharing');
    if (u.hand) tag('hand up');
    // Host controls: only for the host (or a co-host), never on yourself.
    if (amHost && !u.me) {
      const hb = (label, action) => {
        const b = document.createElement('button');
        b.className = 'link small'; b.dataset.action = action; b.dataset.id = u.id; b.textContent = label;
        li.append(b);
      };
      if (u.waiting) hb('Admit', 'admit');
      else {
        if (!u.muted && u.audio) hb('Mute', 'mute-user');
        if (meUser.host) hb('Make host', 'make-host');
      }
    }
    li.append(iconEl(u.muted ? 'micOff' : 'mic', u.muted ? 'muted' : ''), iconEl(u.video ? 'video' : 'videoOff'));
    if (u.speaking) li.style.background = 'var(--hover)';
    return li;
  }));
}
// Rename yourself in the meeting (People tab). Zoom refuses when the host has
// turned renaming off; the error toast says so.
function startRename(btn) {
  const li = btn.closest('li');
  const me = S.meet.users.find((u) => u.me);
  if (!li || !me) return;
  S.renaming = true;
  const form = document.createElement('form');
  form.className = 'rename';
  const input = document.createElement('input');
  input.value = me.name;
  input.setAttribute('aria-label', 'Your name in this meeting');
  input.maxLength = 64;
  const ok = document.createElement('button');
  ok.type = 'submit';
  ok.className = 'link small';
  ok.textContent = 'Save';
  form.append(input, ok);
  li.querySelector('.nm').replaceWith(form);
  btn.remove();
  const done = () => { S.renaming = false; renderPeople(); };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name || name === me.name) { done(); return; }
    ok.disabled = true;
    const r = await zc.rename(name);
    if (r !== false && name !== S.settings.name) { S.settings.name = name; putSettings(); }
    done();
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(); } });
  input.addEventListener('blur', () => setTimeout(() => { if (S.renaming && !form.contains(document.activeElement)) done(); }, 150));
  input.focus();
  input.select();
}
function setPanel(p) {
  S.panel = p;
  $('panel').hidden = !p;
  body.classList.toggle('panel-open', !!p);
  if (p) {
    $('tabChat').setAttribute('aria-selected', p === 'chat');
    $('tabPeople').setAttribute('aria-selected', p === 'people');
    $('chatView').hidden = p !== 'chat';
    $('peopleList').hidden = p !== 'people';
    $('inviteRow').hidden = p !== 'people' || !S.launch;
    if (S.launch) $('inviteInfo').textContent = `ID ${fmtNumber(S.launch.number)}${S.launch.pwd ? ' · passcode ' + S.launch.pwd : ''}`;
    if (p === 'chat') { S.unread = 0; setTimeout(() => $('chatInput').focus(), 0); }
    if (p === 'people') renderPeople();
  }
  requestAnimationFrame(() => zc.fit());
  if (S.screen === 'meeting') renderMeeting();
}
function addChat(m) {
  const list = $('chatList');
  chatEmpty.remove();
  const d = document.createElement('div');
  d.className = 'msg' + (m.me ? ' me' : '');
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = (m.me ? 'You' : m.from) + (m.private ? (m.me ? ` to ${m.to}` : '') + ' (privately)' : '');
  const b = document.createElement('span');
  b.className = 'body';
  b.textContent = m.text;
  d.append(who, b);
  list.append(d);
  list.scrollTop = list.scrollHeight;
  if (!m.me && S.panel !== 'chat') S.unread++;
  renderMeeting();
}

// ---------- Zoom's required chat notice ----------
// Text from Zoom's UI-notice docs / the SDK's own strings (disclaimer.*).
function renderNotice(r) {
  const head = r.cloud || r.local ? 'Who can see your messages? Recording on' : 'Who can see your messages?';
  const body = r.cloud ? 'Recording is on, so the account owner and everyone in the meeting can see and save messages sent to Everyone, and can share them with apps and others.'
    : r.local ? 'Recording is on, so everyone in the meeting can see and save messages sent to Everyone, and can share them with apps and others.'
    : 'Everyone in the meeting can see and save your messages with Everyone, and can share them with apps and others.';
  $('noticeText').textContent = head;
  $('noticeBody1').textContent = body;
}
function toggleNotice(open) {
  const pop = $('noticePop');
  const show = open ?? pop.hidden;
  pop.hidden = !show;
  $('noticeBtn').setAttribute('aria-expanded', show);
}

// ---------- toast: error > breakout invite > in-room chip ----------
let errorTimer = null;
function showError(msg) {
  S.error = msg;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => { S.error = null; renderToast(); }, 7000);
  renderToast();
}
let toastKey = '';
function renderToast() {
  const t = $('toast');
  const b = S.breakout;
  // Rebuilt only when its content changes: state updates arrive several times
  // a second, and replacing the buttons mid-click would swallow the click.
  const hostName = (S.meet.users.find((u) => u.host && !u.me) || {}).name || '';
  const key = JSON.stringify([S.error, S.screen === 'meeting', b.status, b.room && b.room.id, b.room && b.room.name,
    b.canReturn, S.inviteDismissed, hostName, S.leaveAsk]);
  if (key === toastKey) return;
  toastKey = key;
  const parts = [];
  t.className = 'toast';
  const text = (s, strong) => {
    const span = document.createElement('span');
    span.className = 't-text';
    span.append(s);
    if (strong) { const st = document.createElement('strong'); st.textContent = strong; span.append(st); }
    return span;
  };
  const btn = (label, cls, action) => {
    const x = document.createElement('button');
    x.textContent = label;
    if (cls) x.className = cls;
    x.dataset.action = action;
    return x;
  };
  if (S.error) {
    t.classList.add('error');
    parts.push(text(S.error), btn('Dismiss', '', 'dismiss-error'));
  } else if (S.screen === 'meeting' && S.leaveAsk) {
    parts.push(text('Leave, or end the meeting for everyone?'),
      btn('Cancel', '', 'leave-cancel'), btn('Leave', '', 'leave-only'), btn('End for all', 'go', 'end-all'));
  } else if (S.screen === 'meeting' && b.status === 'invited' && b.room && S.inviteDismissed !== b.room.id) {
    const host = S.meet.users.find((u) => u.host && !u.me);
    parts.push(text(`${host ? host.name : 'The host'} invited you to `, b.room.name),
      btn('Not now', '', 'invite-later'), btn('Go to room', 'go', 'invite-join'));
  } else if (S.screen === 'meeting' && b.status === 'in room' && b.room) {
    t.classList.add('room');
    const dot = document.createElement('span');
    dot.className = 't-dot';
    parts.push(dot, text('', b.room.name));
    if (b.canReturn) parts.push(btn('Back to main session', 'plain', 'breakout-leave'));
  }
  t.replaceChildren(...parts);
  t.hidden = parts.length === 0;
}

// ---------- devices ----------
async function openDevices(anchor) {
  S.devicesOpen = true;
  $('devices').hidden = false;
  document.querySelectorAll('[data-action="devices"]').forEach((b) => b.setAttribute('aria-expanded', 'true'));
  if (anchor && S.screen === 'meeting' && S.settings.style === 'standard') {
    const r = anchor.getBoundingClientRect();
    const pop = $('devices');
    pop.style.left = Math.max(16, Math.min(innerWidth - 396, r.left + r.width / 2 - 190)) + 'px';
    pop.style.transform = 'none';
  } else { $('devices').style.left = ''; $('devices').style.transform = ''; }
  try {
    const d = JSON.parse(await zc.devices());
    // Before the camera/mic permission is granted, devices have no labels.
    const named = (list, kind) => list.map((x, i) => {
      const real = x.name && !/input$/.test(x.name);
      return { ...x, name: real ? x.name : `${kind} ${i + 1}`, placeholder: !real };
    });
    S.dev.cams = named(d.cameras, 'Camera');
    S.dev.mics = named(d.mics, 'Microphone');
  } catch {}
  try { S.dev.spk = await api('/api/speakers'); } catch { S.dev.spk = []; }
  renderDevices();
}
function closeDevices() {
  S.devicesOpen = false;
  $('devices').hidden = true;
  document.querySelectorAll('[data-action="devices"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}
function devRow(name, selected, onPick) {
  const b = document.createElement('button');
  b.className = 'dev';
  b.setAttribute('aria-pressed', selected);
  const chk = document.createElement('span');
  chk.className = 'chk';
  if (selected) chk.append(iconEl('check'));
  const nm = document.createElement('span');
  nm.className = 'nm';
  nm.textContent = name;
  b.append(chk, nm);
  b.onclick = onPick;
  return b;
}
function renderDevices() {
  const empty = (txt) => { const p = document.createElement('div'); p.className = 'dev-empty'; p.textContent = txt; return [p]; };
  // Selected: the chosen device (by id, else by remembered label), else the
  // first in the list. Every device is listed; nothing is filtered out.
  const cur = (list, id, label) => (id && list.some((d) => d.id === id) ? id : null)
    || (label && (list.find((d) => d.name === label) || {}).id) || (list[0] || {}).id;
  // Zoom's list can hold the same device twice (same id): show it once, so
  // only one row is ever ticked (live test 2026-11-17: two webcam rows ticked).
  const once = (list) => list.filter((d, i) => !d.id || list.findIndex((e) => e.id === d.id) === i);
  const cams = once(S.dev.cams), mics = once(S.dev.mics);
  const cam = cur(cams, S.dev.cam || window.__zcDev.cameraId, window.__zcDev.camera);
  const mic = cur(mics, S.dev.mic || window.__zcDev.micId, window.__zcDev.mic);
  $('devCams').replaceChildren(...(cams.length ? cams.map((d) => devRow(d.name, d.id === cam, () => pickCam(d))) : empty('No camera found')));
  $('devMics').replaceChildren(...(mics.length ? mics.map((d) => devRow(d.name, d.id === mic, () => pickMic(d))) : empty('No microphone found')));
  $('devSpk').replaceChildren(...(S.dev.spk.length ? S.dev.spk.map((d) => devRow(d.name, d.current, () => pickSpk(d))) : empty('No speakers found')));
}
function remember(kind, d) {
  window.__zcDev[kind] = d.name; window.__zcDev[kind + 'Id'] = d.id;
  if (S.settings[kind] !== d.name || S.settings[kind + 'Id'] !== d.id) { S.settings[kind] = d.name; S.settings[kind + 'Id'] = d.id; putSettings(); }
}
function pickCam(d) {
  S.dev.cam = d.id;
  if (!d.placeholder) remember('camera', d);
  if (S.screen === 'join') { S.previewHold = false; startPreview(); }
  else if (d.placeholder) showError("Zoom hasn't shared device names yet; try again in a moment");
  else zc.useCamera(d.name);
  renderDevices();
}
function pickMic(d) {
  S.dev.mic = d.id;
  if (!d.placeholder) remember('mic', d);
  if (S.screen === 'join') { S.previewHold = false; startPreview(); }
  else if (d.placeholder) showError("Zoom hasn't shared device names yet; try again in a moment");
  else zc.useMic(d.name);
  renderDevices();
}
async function pickSpk(d) {
  try {
    S.dev.spk = await api('/api/speakers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: d.id }) });
    S.settings.speakerId = d.id;
  } catch (e) { showError('Could not switch speakers'); }
  renderDevices();
}
function testSound() {
  const ac = new AudioContext();
  const o = ac.createOscillator(), g = ac.createGain();
  o.frequency.value = 660;
  g.gain.setValueAtTime(0.0001, ac.currentTime);
  g.gain.exponentialRampToValueAtTime(0.2, ac.currentTime + 0.05);
  g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.7);
  o.connect(g).connect(ac.destination);
  o.start();
  o.stop(ac.currentTime + 0.75);
  o.onended = () => ac.close();
}

// ---------- settings ----------
function openSettings() {
  closeDevices();
  renderSettings();
  $('settings').hidden = false;
}
function closeSettings() { $('settings').hidden = true; }
function renderSettings() {
  $('styleStandard').setAttribute('aria-pressed', S.settings.style !== 'keyboard');
  $('styleKeyboard').setAttribute('aria-pressed', S.settings.style === 'keyboard');
  document.querySelectorAll('[data-setting]').forEach((sw) => sw.setAttribute('aria-checked', !!S.settings[sw.dataset.setting]));
  const a = S.account;
  $('acctLine').textContent = a.signedIn ? `Signed in${a.user ? ' as ' + a.user : ''}` : 'Not signed in';
  $('acctHint').textContent = a.signedIn ? 'Joins as your Zoom account'
    : a.configured ? 'Sign in to join as your Zoom account' : 'Sign-in is not available in this build';
  const btn = $('acctBtn');
  btn.hidden = !a.signedIn && !a.configured;
  btn.dataset.action = a.signedIn ? 'signout' : 'signin';
  btn.textContent = a.signedIn ? 'Sign out' : 'Sign in';
  $('newMeeting').hidden = !a.signedIn;
}
// Sign-in runs in the user's default browser (their saved passwords live
// there); Zoom returns to our local server, which sends an 'account' event.
async function signIn() {
  try {
    const r = await fetch('/api/signin', { method: 'POST' });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
    $('acctHint').textContent = 'Finish signing in in your browser, then come back here.';
  } catch (e) { showError("Couldn't open your browser to sign in: " + (e.message || e)); }
}
async function refreshAccount() {
  try {
    const st = await api('/api/status');
    S.account = { signedIn: !!st.signedIn, user: st.user || null, configured: !!st.publicClientConfigured };
  } catch {}
  renderSettings();
  if (S.screen === 'join') renderJoin?.();
}
// Forgets the tokens and asks Zoom to revoke them (Zoom's uninstall rule).
async function signOut() {
  try {
    const r = await fetch('/api/signout', { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    S.account = { ...S.account, signedIn: false, user: null };
    if (!j.revoked) showError("Signed out here, but Zoom didn't confirm revoking access. Remove the app at marketplace.zoom.us → Manage → Added apps.");
  } catch { showError("Couldn't sign out"); }
  renderSettings();
}
// "New meeting": Zoom creates an instant meeting for the signed-in user, and
// the join screen then starts it as host (the same preview and Join as a link).
async function newMeeting() {
  if (S.creating || S.screen === 'meeting') return;
  S.creating = true;
  $('newMeeting').disabled = true;
  try {
    const r = await fetch('/api/new-meeting', { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (r.ok) openLink({ number: j.number, pwd: j.pwd || '', link: j.link || '', host: true });
    else {
      showError(j.error || "Couldn't create a meeting");
      if (j.reauth) signIn(); // signed in before Penguin could create meetings
    }
  } catch { showError("Couldn't create a meeting"); }
  S.creating = false;
  $('newMeeting').disabled = false;
}
// The invitation others need: the meeting's https link when we have one (from
// Zoom or the link the user opened), then the ID and passcode.
async function copyInvite(btn) {
  const l = S.launch;
  if (!l) return;
  const lines = ['Join my Zoom meeting'];
  if (/^https:\/\//.test(l.link || '')) lines.push(l.link);
  lines.push(`Meeting ID: ${fmtNumber(l.number)}`);
  if (l.pwd) lines.push(`Passcode: ${l.pwd}`);
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    if (btn) { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy invite link'; }, 2000); }
  } catch { showError("Couldn't copy the invite"); }
}
function applyStyle() { body.dataset.style = S.settings.style === 'keyboard' ? 'keyboard' : 'standard'; requestAnimationFrame(() => zc.fit()); }

// ---------- events from glue / Rust ----------
function onEvent(json) {
  let e;
  try { e = JSON.parse(json); } catch { return; }
  switch (e.type) {
    case 'state':
      if (S.layoutCheck) break; // ?show= keeps its made-up state
      S.meet = e;
      if (e.joined && S.screen !== 'meeting' && !S.joining) go('meeting');
      if (S.screen === 'meeting') renderMeeting();
      break;
    case 'level': if (S.screen === 'join') setLevel(e.v); break;
    case 'chat': addChat(e); break;
    case 'breakout':
      if (e.status !== 'invited') S.inviteDismissed = null;
      S.breakout = e;
      renderToast();
      break;
    case 'broadcast': showError(`Host: ${e.text}`); break;
    case 'recording': renderNotice(e); break;
    case 'error': showError(e.msg); break;
    case 'left':
      S.wasIn = false;
      S.meet = { joined: false, topic: '', muted: true, video: false, sharing: false, users: [] };
      S.breakout = { status: 'initial', room: null, canReturn: true };
      // Don't reopen the camera and mic by ourselves after a meeting.
      S.previewHold = true;
      go(S.launch ? 'join' : 'idle');
      break;
    case 'open': openLink(e.number ? { number: e.number, pwd: e.pwd || '', link: e.link } : parseLink(e.link)); break;
    case 'cmd': runCmd(e.cmd); break;
    case 'account': refreshAccount(); break;
  }
}
function runCmd(cmd) {
  if (S.screen !== 'meeting') return;
  if (cmd === 'mute-toggle') act('mute');
  else if (cmd === 'camera-toggle') act('video');
  else if (cmd === 'leave') act('leave');
}

// ---------- actions ----------
function act(a, el) {
  switch (a) {
    case 'preview-resume': S.previewHold = false; startPreview(); break;
    case 'new-meeting': newMeeting(); break;
    case 'copy-invite': copyInvite(el); break;
    case 'join-mic': S.previewHold = false; S.joinMic = !S.joinMic; renderJoinToggles(); startPreview(); break;
    case 'join-cam': S.previewHold = false; S.joinCam = !S.joinCam; renderJoinToggles(); startPreview(); break;
    case 'devices': S.devicesOpen ? closeDevices() : openDevices(el); break;
    case 'mute': if (S.meet.joined && !S.meet.audioJoined) zc.joinAudio(); else zc.mute(!S.meet.muted); break;
    case 'video': zc.video(!S.meet.video); break;
    case 'share': zc.share(!S.meet.sharing); break;
    case 'share-change': zc.shareChange(); break;
    case 'admit': zc.admit(Number(el.dataset.id)); break;
    case 'mute-user': zc.muteUser(Number(el.dataset.id)); break;
    case 'make-host': zc.makeHost(Number(el.dataset.id)); break;
    case 'chat': setPanel(S.panel ? null : 'chat'); break;
    case 'people': setPanel(S.panel === 'people' ? null : 'people'); break;
    case 'tab-chat': setPanel('chat'); break;
    case 'tab-people': setPanel('people'); break;
    case 'panel-close': setPanel(null); break;
    case 'layout':
      S.view = S.view === 'gallery' ? 'speaker' : 'gallery';
      zc.view(S.view);
      renderMeeting();
      break;
    case 'leave': {
      // A host with others in the meeting chooses, as in Zoom: leave (Zoom
      // hands host to someone else) or end it for everyone.
      const me = S.meet.users.find((u) => u.me);
      if (me && me.host && S.meet.users.length > 1) { S.leaveAsk = true; renderToast(); } else zc.leave();
      break;
    }
    case 'leave-cancel': S.leaveAsk = false; renderToast(); break;
    case 'leave-only': S.leaveAsk = false; renderToast(); zc.leave(); break;
    case 'end-all': S.leaveAsk = false; renderToast(); zc.end(); break;
    case 'invite-later': S.inviteDismissed = S.breakout.room?.id; renderToast(); break;
    case 'invite-join': if (S.breakout.room) zc.breakoutJoin(S.breakout.room.id); break;
    case 'breakout-leave': zc.breakoutLeave(); break;
    case 'dismiss-error': S.error = null; renderToast(); break;
    case 'test-sound': testSound(); break;
    case 'notice': toggleNotice(); break;
    case 'aan': zc.activeApps(); break;
    case 'settings': openSettings(); break;
    case 'settings-close': closeSettings(); break;
    case 'style-standard': S.settings.style = 'standard'; applyStyle(); renderSettings(); putSettings(); break;
    case 'style-keyboard': S.settings.style = 'keyboard'; applyStyle(); renderSettings(); putSettings(); break;
    case 'signin': signIn(); break;
    case 'signout': signOut(); break;
    case 'rename': startRename(el); break;
  }
}
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (el) { act(el.dataset.action, el); return; }
  const sw = e.target.closest('[data-setting]');
  if (sw) {
    const k = sw.dataset.setting;
    S.settings[k] = !S.settings[k];
    if (k === 'joinMuted') S.joinMic = !S.settings.joinMuted;
    if (k === 'joinCameraOff') S.joinCam = !S.settings.joinCameraOff;
    renderSettings();
    putSettings();
    return;
  }
  if (S.devicesOpen && !e.target.closest('#devices')) closeDevices();
  if (!$('noticePop').hidden && !e.target.closest('.notice')) toggleNotice(false);
});
$('joinForm').addEventListener('submit', doJoin);
$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('chatInput').value.trim();
  if (!t) return;
  $('chatInput').value = '';
  zc.chat(t).then((ok) => { if (!ok && !$('chatInput').value) $('chatInput').value = t; });
});
// Pasted links go through the server's parser (src/launch.rs), the same rules
// as links the app is launched with; a recognised link comes back as "open".
document.addEventListener('paste', (e) => {
  if (e.target.closest('input')) return;
  const text = e.clipboardData.getData('text').trim().slice(0, 2000);
  if (!text) return;
  api('/api/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ link: text, raise: false }) })
    .then((r) => { if (!r || !r.parsed) showError("That doesn't look like a Zoom meeting link"); })
    .catch(() => showError("That doesn't look like a Zoom meeting link"));
});

// Single keys work in both styles (only when not typing).
document.addEventListener('keydown', (e) => {
  if (!e.isTrusted) return; // e.g. the glue closing Zoom's own device menu
  if (e.key === 'Escape') {
    if (!$('settings').hidden) closeSettings();
    else if (S.devicesOpen) closeDevices();
    else if (S.panel) setPanel(null);
    return;
  }
  // F11: fullscreen on/off (the window opens fullscreen). Works while typing too.
  if (e.key === 'F11') {
    e.preventDefault();
    fetch('/api/window', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'fullscreen-toggle' }) }).catch(() => {});
    return;
  }
  if (e.target.closest('input, textarea')) return;
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'l') { if (S.screen === 'meeting') act('leave'); e.preventDefault(); return; }
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const k = e.key.toLowerCase();
  if (k === ',') { openSettings(); return; }
  if (S.screen === 'idle' && k === 'n' && S.account.signedIn) { act('new-meeting'); return; }
  if (k === 'd') { act('devices', S.screen === 'meeting' ? $('btnDevices') : null); return; }
  if (S.screen === 'join') {
    if (k === 'm') act('join-mic');
    else if (k === 'v') act('join-cam');
    else if (k === 'enter' && !e.target.closest('button, a')) doJoin();
    return;
  }
  if (S.screen !== 'meeting') return;
  if (k === 's' && e.shiftKey) { e.preventDefault(); act('share-change'); return; }
  const map = { m: 'mute', v: 'video', s: 'share', c: 'chat', p: 'people', g: 'layout' };
  if (map[k]) { e.preventDefault(); act(map[k]); }
});

// Hide the control bar after a few idle seconds (setting).
let idleTimer = null;
function wake() {
  body.classList.remove('idle-hide');
  clearTimeout(idleTimer);
  if (!S.settings.hideIdle || S.screen !== 'meeting') return;
  idleTimer = setTimeout(() => {
    if (S.devicesOpen || $('pill').matches(':hover')) return wake();
    body.classList.add('idle-hide');
  }, 3000);
}
document.addEventListener('mousemove', wake);
document.addEventListener('keydown', wake);

// ---------- start ----------
async function start() {
  try { Object.assign(S.settings, await api('/api/settings')); settingsLoaded = true; }
  catch { showError("Couldn't load settings; changes won't be saved this time"); }
  // Remembered camera/mic (labels) apply to every capture (glue.js).
  window.__zcDev.camera = S.settings.camera || null;
  window.__zcDev.mic = S.settings.mic || null;
  window.__zcDev.cameraId = S.settings.cameraId || null;
  window.__zcDev.micId = S.settings.micId || null;
  S.joinMic = !S.settings.joinMuted;
  S.joinCam = !S.settings.joinCameraOff;
  applyStyle();
  try {
    const st = await api('/api/status');
    S.account = { signedIn: !!st.signedIn, user: st.user || null, configured: !!st.publicClientConfigured };
  } catch {}
  let launch = null;
  try { launch = await api('/api/launch'); } catch {}
  const q = new URLSearchParams(location.search).get('m');
  const l = q ? parseLink(q) : launch && launch.number ? { number: launch.number, pwd: launch.pwd || '', link: launch.link } : null;
  try {
    await zc.init($('zoomRoot'), onEvent);
  } catch (e) {
    showError('Zoom failed to start: ' + (e.reason || e.message || e));
  }
  if (l) openLink(l); else go('idle');
  // Live tests (scripts/phone/live-test.sh): ?autojoin&name=X joins at once;
  // ?script=a,b,… then runs one UI action every 6 s (the same act() as a
  // click; "say:<text>" sends a chat message).
  const tq = new URLSearchParams(location.search);
  if (l && tq.has('autojoin')) {
    const tlog = (msg) => fetch('/api/log', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level: 'test', msg: String(msg).slice(0, 2000) }) }).catch(() => {});
    setInterval(() => {
      const m = S.meet || {};
      tlog(`state screen=${S.screen} joined=${!!m.joined} audio=${!!m.audioJoined} muted=${!!m.muted} video=${!!m.video} sharing=${!!m.sharing} `
        + `people=${(m.users || []).length} panel=${S.panel} chat=${$('chatList').children.length} view=${S.settings.view || ''} `
        + `error=${S.error ? JSON.stringify(S.error).slice(0, 200) : ''} `
        + `users=${(m.users || []).map((u) => `${u.name}${u.me ? '*' : ''}:${u.host ? 'H' : u.cohost ? 'C' : ''}${u.waiting ? 'W' : ''}`
          + `${u.audio ? (u.muted ? 'm' : 'M') : '-'}${u.video ? 'V' : 'v'}${u.sharing ? 'S' : ''}${u.speaking ? '!' : ''}`).join(',')}`);
    }, 2000);
    for (const k of ['error', 'warn']) {
      const orig = console[k].bind(console);
      console[k] = (...a) => { orig(...a); tlog(`console.${k} ` + a.map((x) => { try { return x instanceof Error ? x.stack || x.message : typeof x === 'object' ? JSON.stringify(x) : String(x); } catch { return String(x); } }).join(' ')); };
    }
    addEventListener('unhandledrejection', (e) => tlog('unhandledrejection ' + (e.reason?.stack || JSON.stringify(e.reason))));
    addEventListener('error', (e) => tlog('onerror ' + e.message));
    $('joinName').value = tq.get('name') || 'Test';
    await doJoin();
    const steps = (tq.get('script') || '').split(',').filter(Boolean);
    const stepMs = +tq.get('stepms') || 6000; // ?stepms=3000: faster soak runs
    for (const step of steps) {
      await new Promise((r) => setTimeout(r, stepMs));
      tlog('step ' + step);
      if (step === 'camprobe') {
        const ids = [...new Set((await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput').map((d) => d.deviceId))];
        for (const id of ['default', ...ids]) {
          try {
            const st = await navigator.mediaDevices.getUserMedia({ video: id === 'default' ? true : { deviceId: { exact: id } } });
            const v = document.createElement('video'); v.muted = true; v.autoplay = true; v.srcObject = st;
            v.style.cssText = 'position:fixed;left:0;top:0;width:160px;height:90px;opacity:0;pointer-events:none';
            document.body.append(v); await new Promise((r) => setTimeout(r, 2500));
            const s = st.getVideoTracks()[0].getSettings();
            tlog(`camprobe ${id.slice(0, 8)} ready=${v.readyState} size=${v.videoWidth}x${v.videoHeight} settings=${JSON.stringify(s).slice(0, 200)}`);
            st.getTracks().forEach((t) => t.stop()); v.remove();
          } catch (e) { tlog(`camprobe ${id.slice(0, 8)} failed ${e.name} ${e.message}`); }
        }
        continue;
      }
      if (step === 'devlist') { try { tlog('devlist ' + JSON.stringify(await zc.devices())); } catch (e) { tlog('devlist failed ' + e); } continue; }
      if (step.startsWith('cam:')) { tlog('useCamera ' + await zc.useCamera(step.slice(4))); continue; }
      if (step.startsWith('mic:')) { tlog('useMic ' + await zc.useMic(step.slice(4))); continue; }
      if (step === 'vstats') { try { tlog('vstats ' + JSON.stringify(await zc.videoStats())); } catch (e) { tlog('vstats failed ' + e); } continue; }
      if (step === 'layout') { try { tlog('layout ' + JSON.stringify(zc.layout())); } catch (e) { tlog('layout failed ' + e); } continue; }
      if (step === 'dump') { try { tlog('dump ' + JSON.stringify(zc.debug())); } catch (e) { tlog('dump failed ' + e); } continue; }
      // Host steps by name: admit:<name>, mute-user:<name>, make-host:<name>.
      const hm = step.match(/^(admit|mute-user|make-host):(.+)$/);
      if (hm) {
        const u = (S.meet.users || []).find((x) => x.name === hm[2]);
        tlog(`${hm[1]} ${hm[2]} -> ${u ? 'user ' + u.id : 'not found'}`);
        if (u) act(hm[1], { dataset: { id: String(u.id) } });
        continue;
      }
      if (step === 'reclaim-host') { zc.reclaimHost(); continue; }
      if (step.startsWith('say:')) { $('chatInput').value = step.slice(4); $('chatForm').requestSubmit(); }
      else act(step, document.querySelector(`[data-action="${step}"]`));
    }
  }
  // ?probe=name (tests): what is on top of the join screen's name field.
  if (tq.get('probe') === 'name') {
    setTimeout(() => {
      const f = $('joinName'), r = f.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const path = (el) => { const p = []; for (let e = el; e && p.length < 6; e = e.parentElement) p.push(e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ').join('.') : '')); return p.join(' < '); };
      f.focus();
      fetch('/api/log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ level: 'test',
        msg: `name field rect=${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)} top=${path(at)} focused=${document.activeElement === f} readOnly=${f.readOnly} disabled=${f.disabled}` }) });
      const keys = [];
      addEventListener('keydown', (e) => keys.push(`${e.key}@${e.target.id || e.target.tagName}${e.defaultPrevented ? '!prevented' : ''}`), true);
      setTimeout(() => fetch('/api/log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ level: 'test',
        msg: `name field value=${JSON.stringify(f.value)} keys=${keys.join(' ')} active=${document.activeElement?.id || document.activeElement?.tagName}` }) }), 6000);
    }, 4000);
  }
  // Off-screen layout checks (tests only, with ?nomedia): ?show=meeting|waiting|sharing|chat|devices|invite|room|settings
  const show = NO_MEDIA && new URLSearchParams(location.search).get('show');
  if (show) {
    S.meet = { joined: show !== 'waiting', topic: 'Layout check', muted: true, video: false, sharing: show === 'sharing',
      users: [{ id: 1, name: 'You', me: true, muted: true }, { id: 2, name: 'Host', host: true }] };
    window.__zcShare.live = show === 'sharing'; // glue's snapshots read this
    S.layoutCheck = true;
    if (show !== 'settings') go('meeting');
    setTimeout(() => fetch('/api/log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ level: 'test',
      msg: `layout show=${show} screen=${body.dataset.screen} class="${body.className}" visible=${[...document.querySelectorAll('#meeting > *, #zoomRoot')].filter((el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).opacity !== '0').map((el) => el.id || el.className).join(',')}` }) }), 2500);
    if (show === 'chat') { setPanel('chat'); addChat({ from: 'Host', text: 'Hello from the layout check', me: false }); addChat({ from: '', text: 'Hi!', me: true }); }
    if (show === 'devices') openDevices($('btnDevices'));
    if (show === 'invite') onEvent(JSON.stringify({ type: 'breakout', status: 'invited', room: { id: 'r2', name: 'Room 2' }, canReturn: true }));
    if (show === 'room') onEvent(JSON.stringify({ type: 'breakout', status: 'in room', room: { id: 'r2', name: 'Room 2' }, canReturn: true }));
    if (show === 'settings') openSettings();
  }
}
start();
