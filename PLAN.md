# Penguin for Zoom: plan and handoff

A Linux desktop app, written in Rust, that joins **real Zoom meetings** through Zoom's own Meeting SDK for Web, inside the system WebKitGTK. Used by the owner only for now; a public release (AUR, GitHub) only if Zoom approves the app and the owner then wants one.

Last updated 2026-11-17. History is in git; this file is the current state. Section 1 is the next steps.

---

## 1. Next steps (in order)

**Before submitting to Zoom's App Review**
1. **Joining as the owner, hosting, signing out, against real Zoom** (Claude, with the phone; **Penguin must be closed**, because both copies would rotate the same refresh token in the keyring):
   - join a phone-hosted meeting signed in (ZAK); note what happens to the phone's own session;
   - host a meeting (role 1: the signer checks the user's token with Zoom) and have the phone join;
   - sign out: does Zoom accept revoke from the public client? (`signout` in `src/server.rs`, still unconfirmed).
2. **One session on the owner's real desktop** (~15 min, with the owner): the real share picker in a meeting, Change, Stop share, closing the window mid-share, fullscreen/F11 on the real screen, a real call for feel.
3. **Remaining checks** (Claude, phone): device switching in a meeting; speaker routing on the real WebKit streams; the Active Apps button; Admit as host (needs a third participant); breakout rooms (need a desktop or browser host; owner).
4. **Share-start crash soak** (§6): more runs with and without the `drawImage` detour; report to WebKitGTK with the cores either way.
5. **Owner decisions:**
   - regenerate both Marketplace client secrets (Development and Production; they appeared in Claude's tool output on 2026-11-17), then update the keyring item and `/etc/penguin-signer.env`;
   - company name on the listing ("Iris") vs. Terms/Privacy ("Aviv Vaknin"): make them match;
   - the GitHub repo `vaknin/penguin-zoom` is public and carries this file: make the repo private or remove the file before submitting.
6. **Submission form** (Publish page; everything else says "Ready for submission"): reviewer notes with a written test plan (owner: no demo video), how reviewers install it (no public build exists), test device "Linux", developer agreement. Domain verification probably appears at this step (HTML file or meta tag on `penguin.kitah.co.il` is easiest; Claude can deploy it).

**At approval**
- Switch `PUBLIC_CLIENT_ID` in `src/server.rs` to the Production public client `A5tAVufnR9KL896jTgthpA`, and put the Production SDK key and secret in `/etc/penguin-signer.env` (signer). Re-check that the Production public client gets past Zoom's authorize page (before approval it answers 4700).
- Then, only if wanted: AUR package (`packaging/PKGBUILD`) and GitHub releases; an "Other distros" section in `AGENT-INSTALL.md` (§8).

---

## 2. Decisions (don't re-open)

| Option | Verdict | Why |
|---|---|---|
| Reverse-engineer Zoom's protocol | ❌ | Against the ToS, changes often, ban risk. |
| Meeting SDK for Linux (C++) | ❌ | No UI; raw media needs host/recording rights in others' meetings. |
| Port the Web SDK to Rust | ❌ | Closed, minified JS + WASM; reverse engineering. |
| Embed Chromium (CEF/Electron/Qt WebEngine) | ❌ owner | Too heavy. |
| **Web SDK (component view) in a Rust app on the system WebKitGTK** | ✅ | No bundled browser; SDK used unchanged. |
| UI in plain HTML/CSS/JS (`ui/`), no build step | ✅ | Thin layer over a JS SDK; everything native stays in Rust. Tauri not used: it sits between us and the WebKitGTK calls we need. |
| Linux-generic, nothing Omarchy/Hyprland-only | ✅ owner | Hyprland extras only as best effort (`hyprctl` raise, `packaging/hyprland.lua`). |
| Install per user without sudo (`scripts/install-user.sh`) | ✅ owner | pacman/AUR only for a public release. |
| Breakout rooms: participant only | ✅ owner | Creating/managing rooms is out. |
| Scope rule | ✅ owner | A light client, not all of Zoom: no whiteboard, apps, Docs, AI Companion, polls, recording controls, virtual backgrounds unless the owner asks. |
| Devices | ✅ owner | List every camera/mic, never filter or auto-pick; use only what the user chose. |
| No demo video for App Review | ✅ owner | |

## 3. How it works

- **Window:** `src/main.rs`, tao + wry over WebKitGTK 4.1. Opens fullscreen (F11 toggles via `POST /api/window`); window class `penguin-zoom` (`glib::set_prgname`); closing the window or SIGTERM/SIGINT/SIGHUP leaves the meeting first (no ghost participant). Links that open new windows go to the system browser (http/https only).
- **Local server:** `src/server.rs`, axum on `127.0.0.1:53682` only; answers only Host `127.0.0.1:53682`/`localhost:53682` and refuses other origins for anything that changes state or returns secrets (DNS rebinding). COOP/COEP on every response (cross-origin isolation). Single instance: a second launch hands its link over (`/api/open`).
- **Page:** `ui/` (screens: idle, join, waiting room, meeting, settings) + `web/glue.js` (`window.zc`, the SDK wrapper). The SDK has no public call for camera on/off, share or device choice, so `glue.js` presses Zoom's own toolbar buttons by aria-label with Zoom's chrome collapsed (`hideZoomChrome`). **Re-check those labels on every SDK upgrade.** `fit()` sizes/scales Zoom's view into `#zoomRoot` (Zoom adds its own header/toolbar height and ignores `viewSizes` during a share).
- **SDK:** `@zoom/meetingsdk` 6.10.0, fetched by `scripts/fetch-sdk.sh` into `assets/zoom-sdk/` (gitignored; Zoom's terms govern redistribution). JWT signature with `video_webrtc_mode: 0` (this WebKitGTK has no WebRTC; Zoom falls back to WASM video).
- **Signing:** the hosted signer (`signer/`, `https://penguin.kitah.co.il/v1/signature`) holds the SDK secret; `PENGUIN_SIGNER_URL` overrides, empty = sign locally with the keyring secret (development only). Role 1 needs the user's Zoom token, checked with Zoom.
- **Sign-in** (Settings → Sign in): `POST /api/signin` opens Zoom's authorize page in the **default browser** (`xdg-open`; the user's saved passwords live there). Public client + PKCE (S256), no secret. Zoom redirects to `https://penguin.kitah.co.il/oauth/callback`, a static page (`site/oauth/bounce.js`) that forwards `?code&state` in the browser to `http://127.0.0.1:53682/oauth/callback`, where the app exchanges the code; the browser shows "Signed in, close this tab" and the window comes forward. Why the https hop: Zoom's authorize page refuses the loopback redirect for this app ("Invalid redirect URL" 4700), even though Zoom's docs allow it. `PENGUIN_REDIRECT_URI` overrides.
- **Tokens:** refresh token in the keyring (`secret-tool`, service `penguin-zoom`, key `refresh-token`), replaced on every refresh, cleared on sign-out or when Zoom answers 400/401 (429/5xx/no network keep it). Access token, ZAK and the "Signed in as Name (email)" label (`GET /v2/users/me`) in memory only. `PENGUIN_NO_KEYRING=1` for tests.
- **Screen share:** WebKit's own capture gives black frames (DMA-BUF import) and can crash, so `src/screencast.rs` opens the ScreenCast portal itself (ashpd), reads PipeWire with GStreamer, sends JPEGs over a WebSocket; `web/screencast.js` replaces `getDisplayMedia` with a canvas track. The portal restore token (`~/.local/state/penguin-zoom/screencast-token`) skips the picker after the first share; **Change** (Shift+S) asks again and swaps the source without restarting the share. `?webkitshare` = WebKit's own path; `ZOOM_SHARE_SOURCE=test` = test pattern, no portal.
- **Speakers:** WebKitGTK has no `setSinkId`; the Rust side moves the app's PulseAudio/PipeWire playback streams to the chosen sink (`src/speakers.rs`).
- **Settings:** `~/.config/penguin-zoom/settings.json` (camera/mic saved by id and label). Settings: gear at the top right of every screen, or `,`.
- **Desktop-wide keys:** `penguin-zoom --cmd mute-toggle|camera-toggle|leave|raise`, bound in any desktop's shortcut settings (the owner's Hyprland: SUPER+SHIFT+M / SUPER+SHIFT+L in `~/.config/hypr/bindings.lua`; the owner's window rule there is only `idle_inhibit`).
- **Install:** `scripts/install-user.sh` (release build → `~/.local/bin/penguin-zoom`, data in `~/.local/share/penguin-zoom`, launcher "penguin", zoommtg/zoomus handler; `--remove`). The binary looks for its files at `<prefix>/share/penguin-zoom`, then `/usr/share/penguin-zoom`, then the source tree. An old pacman install still sits in `/usr`, shadowed; remove with `sudo pacman -R penguin-zoom` when convenient.

## 4. WebKitGTK 2.54 workarounds (remove when fixed upstream)

| Problem | Workaround | Off switch |
|---|---|---|
| `SharedArrayBuffer` missing despite cross-origin isolation ([bug 317847](https://bugs.webkit.org/show_bug.cgi?id=317847), fixed on main) | `JSC_useSharedArrayBuffer=1` before GTK starts | `ZOOM_SPIKE_NO_SAB=1` |
| No Screen Orientation API; SDK reads `screen.orientation.type` | shim in `glue.js` | |
| WebGL in workers is null → receiving a share breaks | features `AllowWebGLInWorkers` + `UseGPUProcessForWebGL` | `ZOOM_SPIKE_NO_WEBGL_WORKERS=1`; `ZOOM_SPIKE_FEATURES=Name=1,…` |
| Remote audio silent: WirePlumber restores 0 % volume per app | `PULSE_PROP=state.restore-props=false` | |
| Camera frozen after long uptime: `videorate` catches up from boot time (GStreamer ≥1.28 dropped `drop-only`) | `gst/camfix.c` tracer sets `skip-to-first` (built by `build.rs`, loaded via `GST_PLUGIN_PATH`/`GST_TRACERS`) | `PENGUIN_NO_CAMFIX=1` |
| Every second camera frame dropped (appsink QoS) and hidden camera `<video>` never starting: both from `isMediaStreamPlayer()` answering "no" while the pipeline is built | camfix also turns QoS off on `webkit-gl-video-appsink`; `WEBKIT_GST_ALLOW_PLAYBACK_OF_INVISIBLE_VIDEOS=1`; viewport pin in `glue.js` | `PENGUIN_SUSPEND_HIDDEN_VIDEO=1` |
| Share crash in `memcpy` when Zoom reads our canvas-track `<video>` | `drawImage` detour in `glue.js` (draw the canvas itself) | `?novideodetour` |

- **Upstream fix sent:** [WebKit PR #81251](https://github.com/WebKit/WebKit/pull/81251), [bug 331962](https://bugs.webkit.org/show_bug.cgi?id=331962) (`isMediaStreamPlayer()` also checks `m_streamPrivate`); out of draft, waiting for review. Keep the workarounds until a WebKitGTK release with it reaches Arch. Re-test SAB when 2.56 arrives.
- Arch's WebKitGTK has no WebRTC (`RTCPeerConnection` undefined); don't spoof a Chrome user agent (the SDK would take Chrome-only paths).
- COEP `credentialless` is not supported by WebKit; `require-corp` only.

## 5. Zoom and server setup

- **Marketplace app** "Penguin for Zoom" (General, user-managed, **unlisted**, **not available in the EU** — so no trader/bank/ID details are needed; reversible), app id `-J2PcmmWQ76WT4RcRyjRXw`. Development: client `QIyq0AOWRRCCEFesq_s52w`, public client `I7gQRtV3QNK0b48jBgUE0Q` (used by the app now). Production: client `cUyRB6qBS36fuXMveshsQ`, public client `A5tAVufnR9KL896jTgthpA`. IDs are not secret; secrets never go in the repo, chat or logs.
- **Both modes:** OAuth redirect and allow list `https://penguin.kitah.co.il/oauth/callback`; PKCE redirect `http://127.0.0.1:53682/oauth/callback`; Meeting SDK on, "meeting bot" off. **Scopes** (shared by both modes, one description): `user:read:token` (ZAK), `user:read:user` (name/email). **Production only:** public-client justification, deauthorization URL `https://penguin.kitah.co.il/v1/zoom-webhook`, developer contact, App listing, Technical Design. All texts are in `docs/marketplace-answers.md`; images in `docs/listing/`, `docs/architecture.{svg,png}`.
- **Don't upload `manifest.json` again** without checking: it has no field for the PKCE redirect, and the first upload seems to have cleared it. It mirrors the Marketplace as of 2026-11-17 otherwise.
- The Marketplace pages can be driven by Claude in a headless Brave on the `headless-browser` skill's saved profile (signed in to the Marketplace); verify every field after a reload. Never print secret fields.
- **Server:** Oracle Cloud VM `82.70.221.64` (`ssh kitah-vm`, notes in `~/Projects/VM/README.md`). Domain `kitah.co.il` (DNS on Cloudflare; only the owner has access). Caddy serves `penguin.kitah.co.il` (+ `82-70-221-64.sslip.io`): `site/` pages and the signer (`/v1/*`, `/healthz`); other sites in the main Caddyfile (`kitah.co.il`, an iroh relay) are kept. Deploy: `PENGUIN_HOSTS="penguin.kitah.co.il, 82-70-221-64.sslip.io" signer/deploy/deploy.sh ubuntu@82.70.221.64` (also copies `site/`). Webhook secret: `signer/deploy/set-webhook-secret.sh` (set and verified).
- **Free Zoom account:** meetings end after 40 min, then ~5–10 min before the phone can start another. The camera is sent at 640×360 (likely the account's HD setting, not us).

## 6. Known issues

- **Share-start crash** (WebKitWebProcess): 3 crashes in 127 starts without the detour, 1 (a different kind: SIGILL on a worker thread after a stop) in ~119 with it. Not proven fixed. Cores from 2026-11-17 06:05:50 and 06:12:32 are complete; report upstream.
- Phone-side frame rate: Zoom sends 640×360 at ~27 fps; the in-page camera runs at 30.
- The webcam's infrared sensor shows up as a second "USB2.0 HD UVC WebCam"; telling the user which one is IR would help.
- `IMPROPER_MEETING_STATE "on hold"` unhandled rejections in waiting-room joins; no visible effect.
- Zoom's own chat/AAN notices are shown (chat "Who can see your messages?", Active Apps button, Terms/Privacy line under Join) for review.

## 7. Testing

- **GUI tests never run in the owner's Hyprland session** (a headless output there froze the desktop once). `scripts/headless-run.sh <secs> <outdir> [url] [shot-secs…]` runs the app in **cage** (headless wlroots, no input; `CAGE_RENDERER=gles2` for the GPU, `NICE`, `BIN=<binary>`, `USE_KEYRING=1` to use the real sign-in). Layout checks without media: `/?nomedia&show=meeting|chat|devices|invite|room|settings|waiting|sharing`.
- **Phone** (Pixel 8, Zoom app on the owner's account, hosts the test meetings): `android-ui-driver` skill (`adb-connect` tries every route; `dr unlock` types the PIN once). Zoom actions: `scripts/phone/zp start|info|mic|cam|share|stop-share|admit|make-host|allow-share|leave|state|ui|shot`; **always `zp quit` at the end** (restores animations). Work dir `S=<dir>` holds `meeting.txt`.
- **Live runs:** `S=<dir> scripts/phone/live-test.sh <name> <secs> "<steps>"` (steps 6 s apart: UI actions, `say:<text>`, `layout`, `vstats`, `devlist`, `cam:<label>`, `admit:<name>`, `mute-user:<name>`, `make-host:<name>`; `?stepms=` changes the interval). `two-way-test.sh`, `join-loop.sh`. State lines: `users=Name:flags` (H host, M/m mic, V/v video, S sharing, `*` us, `!` speaker).
- **Diagnostics:** `?vidstats`, `?workerstats`, `?copylog`, `?workerlog`, `?probegrab`, `?probecanvas`; `scripts/diag/camfps.html`, `devid.html` (copy into `ui/` as `_*.html` to use; never leave them there); `scripts/playback-check.sh`, `audio-test.sh`.
- **Never** let real camera video or the owner's profile picture into committed images (gallery/README shots are taken with cameras off; the phone tile's picture is painted over).
- Don't remove a ghost "Penguin test" from the phone's participant list: Zoom then refuses later joins from this machine to that meeting (3009). Start a new meeting instead.
- `cargo test` (20 tests: JWT, redaction, settings, sign-in logic against a stand-in Zoom).

## 8. Later (only if the app is approved and the owner wants it)

- **Other distros:** nothing in the app is Arch-specific; only the install route is. Packages elsewhere: `libwebkit2gtk-4.1-0` (Debian/Ubuntu), `webkit2gtk4.1` (Fedora), GStreamer `-bad`/`-libav` (RPM Fusion on Fedora), Rust ≥ 1.85. Cheapest first: an "Other distros" section in `AGENT-INSTALL.md`, then AUR, then Flatpak.
- **Upkeep:** Zoom raises the minimum SDK version quarterly ([policy](https://developers.zoom.us/docs/meeting-sdk/minimum-version/)); 6.10.0 is fine through February 2027. Bump and re-test a couple of times a year.

## 9. Zoom review: rules and risks

- Review is required to join meetings outside the owner's account (until then: own account only) and before any third-party use. It can end in an unlisted app.
- Done for review: hosted signer (secret off the client), name "Penguin for Zoom" (no "Zoom" alone), Terms/Privacy/Support/Docs on our domain, sign-out with revoke, deauthorization endpoint, minimal scopes, SDK fetched at build time, Zoom's notices kept visible.
- **Biggest risk:** ToU 3.1(ii), "recreate the features or functionality of Zoom's services" / "confusingly similar". Present it as a light Linux meeting app built on the Meeting SDK, with its own look (penguin icon, not a camera). Answers to reviewers must be accurate.
- Other risks: reviewers can't easily run Linux/WebKitGTK; they may ask for a video anyway; OWASP testing of the signer; hiding Zoom's chrome (no explicit rule found).

## 10. Things not to do

- Don't modify, decompile or re-implement Zoom's SDK.
- Don't commit or log client secrets, OAuth tokens or the ZAK; don't print secret fields from the Marketplace.
- Don't edit `~/Projects/.mise.toml` (shared); pin tools in this folder's `mise.toml` (Rust 1.100).
- Don't run GUI tests in the owner's Hyprland session; don't take the owner's focus or keyboard.
