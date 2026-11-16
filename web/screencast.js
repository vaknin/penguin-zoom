// Screen share without WebKit's capturer (PLAN.md §4.2, src/screencast.rs).
//
// WebKitGTK 2.54's own getDisplayMedia delivers black frames (DMA-BUF import)
// and can crash the web process. This replaces it: the Rust side opens the
// ScreenCast portal and streams JPEG frames over /api/screencast; we draw them
// on a canvas and return canvas.captureStream(), which Zoom encodes like any
// other video track. Must load before glue.js / spike.js, which wrap
// getDisplayMedia themselves. `?webkitshare` keeps WebKit's own capture.
//
// One share = one canvas and one track for its whole life. "Change" (sharing
// something else) only swaps the source feeding the canvas
// (window.__zcScreencast.change()): Zoom keeps sharing the same track. Stopping
// and restarting the share instead crashed WebKitWebProcess (live test
// 2026-11-16, SIGSEGV 2 s after the new share started).
(() => {
  'use strict';
  if (!window.MediaDevices?.prototype || location.search.includes('webkitshare')) return;
  const log = (level, msg) => fetch('/api/log', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ level, msg: 'screencast: ' + msg }),
  }).catch(() => {});

  const FPS = 15;

  // A capture source: one WebSocket to the Rust side. Resolves once frames
  // start; rejects with a DOMException like getDisplayMedia (NotAllowedError
  // when the picker is cancelled).
  function openSource(choose) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${location.host}/api/screencast${choose ? '?choose=1' : ''}`);
      ws.binaryType = 'arraybuffer';
      const src = {
        started: false, closed: false, onframe: null, onend: null, width: 0, height: 0, remembered: false,
        close() { this.closed = true; try { ws.close(); } catch {} },
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') { src.onframe?.(ev.data); return; }
        const m = JSON.parse(ev.data);
        if (m.type === 'started') {
          Object.assign(src, { started: true, width: m.width, height: m.height, remembered: !!m.remembered });
          resolve(src);
        } else if (m.type === 'resized') {
          log('info', `resized ${m.width}x${m.height}`);
        } else if (m.type === 'error') {
          if (!src.started) reject(new DOMException(m.message, m.name || 'NotReadableError'));
          else src.onend?.('error: ' + m.message);
        } else if (m.type === 'ended') {
          src.onend?.('source ended');
        }
      };
      ws.onclose = () => {
        if (!src.started) reject(new DOMException('screen capture closed', 'AbortError'));
        else if (!src.closed) src.onend?.('socket closed');
      };
      ws.onerror = () => log('warn', 'socket error');
    });
  }

  // The share Zoom holds: a canvas, its captureStream track, and the source
  // currently drawing into it.
  function makeShare(first) {
    const canvas = document.createElement('canvas');
    // Kept inside the viewport but invisible: WebKitGTK may skip work for
    // elements it doesn't render (it does for <video>, §4.2).
    canvas.style.cssText = 'position:fixed;left:0;top:0;width:16px;height:9px;opacity:0;pointer-events:none;z-index:-1';
    canvas.width = first.width; canvas.height = first.height;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    document.body.append(canvas);
    const stream = canvas.captureStream(FPS);
    const [track] = stream.getVideoTracks();
    const origStop = MediaStreamTrack.prototype.stop;
    const sh = { stream, track, src: null, ended: false, frames: 0 };
    let busy = false, pending = null;

    // Decode the newest frame only; frames that arrive mid-decode replace
    // each other, so a slow page drops frames instead of lagging.
    const draw = async (buf) => {
      if (busy) { pending = buf; return; }
      busy = true;
      try {
        while (buf && !sh.ended) {
          const bmp = await createImageBitmap(new Blob([buf], { type: 'image/jpeg' }));
          if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
            canvas.width = bmp.width; canvas.height = bmp.height;
          }
          ctx.drawImage(bmp, 0, 0);
          bmp.close?.();
          sh.frames++;
          buf = pending; pending = null;
        }
      } catch (e) { log('warn', 'frame decode failed: ' + e); }
      busy = false;
    };
    const attach = (src) => {
      src.onframe = (buf) => { if (sh.src === src) draw(buf); };
      src.onend = (why) => { if (sh.src === src) sh.finish(why); };
    };
    sh.finish = (why) => {
      if (sh.ended) return;
      sh.ended = true;
      log('info', 'ended: ' + why + ` (${sh.frames} frames drawn)`);
      sh.src?.close();
      canvas.remove();
      if (track.readyState === 'live') {
        origStop.call(track);
        // A canvas track never ends by itself; Zoom listens for 'ended'.
        track.dispatchEvent(new Event('ended'));
      }
    };
    sh.switchTo = (src) => {
      const old = sh.src;
      sh.src = src;
      attach(src);
      old?.close();
    };
    // Zoom stops the track to end the share: close the source too.
    track.stop = function () { sh.finish('track stopped'); };
    sh.switchTo(first);
    return sh;
  }

  let active = null;

  // The Rust side remembers the last choice and reuses it without the picker.
  // Set window.__zcShareChoose = true before a share to show the picker
  // anyway; it is consumed by that one share.
  async function nativeDisplayMedia() {
    const choose = window.__zcShareChoose === true;
    window.__zcShareChoose = false;
    const src = await openSource(choose);
    active = makeShare(src);
    window.__zcShareRemembered = src.remembered;
    log('info', `started ${src.width}x${src.height}${src.remembered ? ' (last choice)' : ''}`);
    return active.stream;
  }

  window.__zcScreencast = {
    get active() { return !!(active && !active.ended); },
    // Share something else in the running share: picker, then the new
    // source takes over the same track. Cancelling keeps the current one.
    async change() {
      if (!active || active.ended) return false;
      const sh = active;
      try {
        const src = await openSource(true);
        if (sh.ended) { src.close(); return false; }
        sh.switchTo(src);
        log('info', `changed to ${src.width}x${src.height}`);
        return true;
      } catch (e) {
        log('info', `change kept the current source (${e.name}: ${e.message})`);
        return false;
      }
    },
  };

  MediaDevices.prototype.getDisplayMedia = function () { return nativeDisplayMedia(); };
})();
