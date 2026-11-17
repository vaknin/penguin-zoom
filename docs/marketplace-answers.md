# Marketplace answers (Penguin for Zoom)

Text for the Zoom Marketplace forms. Everything here must stay true to the code and to
`site/privacy.html`; change both together.

## Scope description: `user:read:token`

Used only to get the user's ZAK (GET /v2/users/me/token?type=zak) right before each meeting join. The app hands the ZAK to the Zoom Meeting SDK so the user joins the meeting as themselves. The ZAK is kept only in the app's memory for that join, is sent nowhere except Zoom, and is never written to disk. No Zoom data is stored on any server we run. To keep the user signed in, the OAuth refresh token is stored only on the user's own computer, in the operating system's keyring (Secret Service, e.g. GNOME Keyring, which keeps it encrypted at rest). The access token is held in memory only. Signing out revokes the token with Zoom and deletes it from the keyring.

## Why public client OAuth in production

Penguin for Zoom is a desktop application that each user installs and runs on their own Linux computer. A desktop app cannot keep a client secret confidential: anything shipped in the program can be extracted from it. This is the case Zoom's PKCE guidance describes, so the app signs in as a public client using the Authorization Code flow with PKCE (S256) and no client secret. The redirect goes to a loopback address (http://127.0.0.1:53682/oauth/callback), served by the app itself and bound to 127.0.0.1 only, and the app checks the OAuth state parameter before redeeming the code. The confidential client secret never leaves our server: Meeting SDK signatures are created by our hosted signing service (https://penguin.kitah.co.il), not on the user's computer.

## Short description

A lightweight Linux desktop app for joining Zoom meetings, built on the Zoom Meeting SDK.

## Long description

Penguin for Zoom is a small desktop app for Linux, especially Wayland desktops, that joins Zoom meetings through the official Zoom Meeting SDK.

- Open a Zoom meeting link and join with audio, video and screen sharing.
- Mute, camera, screen share, gallery and speaker view, chat and a participant list in a compact control bar.
- Choose your camera, microphone and speakers.
- Join breakout rooms when the host invites you.
- Keyboard shortcuts for mute and leave.

Sign in with your own Zoom account. The app asks Zoom only for the token needed to join meetings as you; it does not read your meetings, contacts, recordings or chat history, and it keeps no data about you on any server.

Penguin for Zoom is an independent app and is not made, endorsed or supported by Zoom. Support: https://penguin.kitah.co.il/support.html

## Categories (suggested)

- Marketplace category: Collaboration (or Productivity, whichever the list offers)
- Industry category: All industries / Technology

## Technical design: Application overview

Penguin for Zoom is a desktop application for Linux, written in Rust. It opens a native window with the system web view (WebKitGTK) and loads the Zoom Meeting SDK for Web (component view) from files installed with the app; the SDK is used unchanged. A small HTTP server inside the app, bound to 127.0.0.1:53682 only, serves the app's interface to its own window and handles the OAuth redirect.

Flow of a join:
1. The user opens a Zoom meeting link (the app registers as the handler for zoommtg:// links) or pastes one.
2. If signed in, the app fetches a fresh ZAK with GET /v2/users/me/token?type=zak.
3. The app asks our signing service for a Meeting SDK signature for that meeting number. The service signs a JWT with the app's SDK credentials (role 0 for participants; role 1 only after verifying the user's Zoom access token with Zoom).
4. The SDK joins with the signature (and the ZAK when signed in). Audio, video, screen share and chat run through the SDK.

Components:
- Desktop app (user's computer): window, interface, local server, OAuth (Authorization Code + PKCE, public client), token storage in the OS keyring.
- Signing service (https://penguin.kitah.co.il/v1/signature): a small Rust service on an Oracle Cloud VM in Israel, behind Caddy with HTTPS. It holds the SDK secret, has no database, and keeps nothing after a request. It also receives the deauthorization webhook.
- Public pages (Terms, Privacy, Support, Docs) on the same host.

Scopes: user:read:token only.

## Technical design: Security overview

- Secrets: the SDK client secret exists only on the signing server, in a root-only (mode 600) environment file. It is never shipped in the app, logged or sent to clients.
- Sign-in: OAuth 2.0 Authorization Code with PKCE (S256), public client, no client secret in the app. The OAuth state is checked before the code is redeemed. The redirect is a loopback URL on 127.0.0.1.
- Tokens: the access token and ZAK are kept in memory only. The refresh token is stored in the OS keyring (Secret Service, encrypted at rest), replaced on every refresh, and deleted on sign-out or when Zoom rejects it. Sign-out calls Zoom's revoke endpoint. Tokens are masked in the app's diagnostic output.
- Local server: bound to 127.0.0.1 only; it answers only requests whose Host is 127.0.0.1:53682 or localhost:53682 (against DNS rebinding) and refuses requests from other origins for anything that changes state or returns tokens. Only http(s) links are passed to the system browser.
- Signing service: HTTPS only (TLS certificates from Let's Encrypt, HSTS), request bodies limited to 4 KB, timeouts on all connections, rate limiting per client IP held in memory only, no access logs, no database, no stored IP addresses or tokens. Host (role 1) signatures require a valid Zoom access token, checked with Zoom; only a one-way hash is cached in memory for a few minutes. The service runs as an unprivileged system user under a hardened systemd unit. The server accepts SSH with keys only and has automatic security updates and fail2ban.
- Webhooks: deauthorization notifications are verified with Zoom's signature (x-zm-signature, HMAC-SHA256 with the app's secret token) and the URL validation challenge.
- Data: no analytics, telemetry or tracking. No meeting content or personal data passes through or is stored on our servers; meeting media goes directly between the app and Zoom.

## EU & discoverability (owner only)

Business name, address, email, phone, bank details, trade register number, identity document and the trader compliance declaration are the owner's legal details. Claude does not fill these in.
