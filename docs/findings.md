# Measured findings

Facts about Zoom's Web SDK and WebKitGTK that took live runs to learn. Re-measure after an SDK or WebKitGTK upgrade; the "How to measure" lines say how.

## Self-view latency (2026-11-17, SDK 6.10.0, WebKitGTK 2.54)

Your own video is drawn locally; nothing goes through Zoom's servers or the encoder first.

| Stage | Cost |
|---|---|
| WebKit's camera pipeline (`jpegdec`, capturer appsink, `capture-videosrc` → `webkit-gl-video-appsink`) | ~4 + ~4 ms |
| Capture timestamp → frame available to the page | ~10 ms |
| Zoom copies the frame from its hidden camera `<video>` (`new VideoFrame(video)`) and draws it with WebGL `texImage2D` on the main thread, at ~23 fps, not 30 | up to ~43 ms |
| Display (next frame on screen) | ~16 ms |
| Camera's own sensor/USB latency | not measured |

- The camera track itself runs at 30 fps (1280×720). The 23 fps redraw rate is Zoom's choice; nothing in the app can change it.
- Showing the camera ourselves on top of Zoom's self tile would save only ~20–40 ms and would mean tracking Zoom's tile layout: not worth it.

How to measure:
- `?vidstats`: per-second counts of `new VideoFrame`, `texImage2D`, `drawImage` and the frame rate of each live `<video>`.
- `?workerstats`: what Zoom's workers receive (the encoder worker gets the same `VideoFrame`s).
- Test step `camlag`: `requestVideoFrameCallback` timings on the camera `<video>` (now − captureTime, frames presented).
- GStreamer latency tracer inside WebKit: `GST_TRACERS="latency(flags=pipeline+element)" GST_DEBUG=GST_TRACER:7 GST_DEBUG_FILE=<file>` (added to the app's own camfix tracer). Lines `:: latency,` give source→sink per pipeline, `:: element-latency,` per element. The log grows ~2 MB/s.

## Remote audio buffering

- Remote audio sits ~127 ms in a `queue` between `webaudioSrc` and `autoaudiosink` (GStreamer latency tracer, same run). That's WebKit's Web Audio output, not Zoom's.

## Zoom's floating windows

- Breakout Rooms, dialogs and menus are MUI portals on `<body>` (`zoom-MuiPopper-root`, `position: absolute`, `z-index: 2`, placed by an inline `transform`).
- Zoom sizes them in JS from `window.innerHeight`: the room list is a `ReactVirtualized__List` with an inline pixel height (519 px at 1280×720, taller on bigger screens). A CSS max-height can't shrink them.
- The window's drag offset is on an inner `.react-draggable`, so the portal's own box stays where Zoom placed it.
- `keepWindowsClear()` in `web/glue.js` fits every such window into the space our fixed controls leave free (moves it, then CSS `zoom` to shrink it). The controls are listed in `zc.init(…, { chrome })` in `ui/app.js`; a new fixed control in the meeting goes there.

How to measure: test step `zwin` (each floating window's rect, z-index, and the boxes inside it that set a height).

## Number fields

- Zoom draws its own arrows on number fields (breakout room count); WebKit's spinner doubled them. `ui/style.css` hides WebKit's spinner on every `input[type=number]`.
