# penguin-signer

A small HTTPS service that signs Zoom Meeting SDK JWTs for **Penguin for Zoom**.

Zoom's API terms don't allow the Meeting SDK secret to ship inside a client
app, so the desktop app asks this service for a signature instead of signing
locally. The service also receives Zoom's `app_deauthorized` webhook. It
keeps no user data: no database, no IPs in logs, no tokens on disk.

It is a standalone Rust crate (axum + tokio, rustls; no OpenSSL). It listens
on `127.0.0.1:8080` behind Caddy, which handles TLS.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/signature` | Body `{"meetingNumber": "123 4567 8901", "role": 0}` returns `{"signature": "<JWT>", "meetingNumber": "12345678901"}` |
| `POST` | `/v1/zoom-webhook` | Zoom event webhook: answers `endpoint.url_validation` and records `app_deauthorized` |
| `GET` | `/healthz` | Returns `ok` |

### `/v1/signature`

- `meetingNumber` can be a string or a number. Everything except digits is
  removed. It is rejected (400) if nothing is left or if more than 13 digits
  remain.
- **role 0 (attendee)**: no login needed. Limited per client IP to 60 per hour
  with a burst of 10. Over the limit you get `429` with a `Retry-After` header.
  The client IP is the last `X-Forwarded-For` hop set by Caddy. IPv6 addresses
  are grouped by /64.
- **role 1 (host)**: needs `Authorization: Bearer <Zoom user OAuth access token>`.
  The service checks the token by calling `GET https://api.zoom.us/v2/users/me/token?type=zak`
  with it (the app's scope is `user:read:token`). If Zoom refuses that call for
  a reason other than 401, it tries `/v2/users/me/zak` instead. A 2xx means the token is valid. The
  ZAK in the response is thrown away. Valid tokens are cached for 5 minutes,
  keyed by their SHA-256 hash, so the token itself is never stored. A missing
  or rejected token gets `401`. If Zoom can't be reached, the response is
  `502`. Host attempts whose token isn't already cached count against the same
  per-IP limit.
- JWT: HS256. The payload is
  `{appKey, mn, role, iat: now-30, exp: iat+2h, tokenExp: exp, video_webrtc_mode: 0}`.
  This is the same payload the app used to sign locally. `video_webrtc_mode: 0`
  is needed because WebKitGTK has no `RTCPeerConnection`.

### `/v1/zoom-webhook`

These rules follow <https://developers.zoom.us/docs/api/webhooks/>.

- **Every request** must carry `x-zm-signature`, and it must equal
  `v0=` + hex HMAC-SHA256(`ZOOM_WEBHOOK_SECRET`, `v0:{x-zm-request-timestamp}:{raw body}`).
  The timestamp is in Unix seconds and must be within 5 minutes of now.
  Anything else gets `401`.
- `endpoint.url_validation` returns
  `{plainToken, encryptedToken: hex HMAC-SHA256(ZOOM_WEBHOOK_SECRET, plainToken)}`.
- `app_deauthorized` logs only the event type and returns `200`. There is no
  stored user data to delete.
- If `ZOOM_WEBHOOK_SECRET` isn't set, this endpoint returns `503`.

### Limits and behaviour

- Request bodies are limited to 4 KB, by both the app and Caddy.
- Requests time out after 10 s, and the call to Zoom times out after 5 s.
- No CORS headers are sent. The desktop app calls the service from Rust, not
  from a browser.
- Logs go to journald as JSON lines: method, route, status, latency, role and
  outcome. No IPs, tokens, meeting numbers or webhook payloads are logged.

### Configuration (environment)

| Variable | Required | Default |
|---|---|---|
| `ZOOM_SDK_KEY` | yes (refuses to start without it) | |
| `ZOOM_SDK_SECRET` | yes (refuses to start without it) | |
| `ZOOM_WEBHOOK_SECRET` | for the webhook | |
| `BIND` / `PORT` | | `127.0.0.1` / `8080` |
| `RATE_PER_HOUR` / `RATE_BURST` | | `60` / `10` |
| `ZOOM_API_BASE` | | `https://api.zoom.us` (only changed for tests) |

The service refuses to start, with exit code 2, if any value still contains the
`REPLACE_ME` placeholder from `deploy/penguin-signer.env.example`.

## Develop

```sh
cd signer
cargo test
cargo clippy --all-targets
ZOOM_SDK_KEY=dummy ZOOM_SDK_SECRET=dummy PORT=18080 cargo run
curl -s localhost:18080/healthz
curl -s -H 'content-type: application/json' -d '{"meetingNumber":"123456789","role":0}' localhost:18080/v1/signature
```

## Hosting on Oracle Cloud Always Free (step by step)

Files in `deploy/`:

- `cloud-init.yaml`: first-boot setup for the VM.
- `deploy.sh`: build and install. Run it for the first install and for every update.
- `penguin-signer.service`: the hardened systemd unit.
- `Caddyfile`: the HTTPS front end.
- `open-web-ports.sh`: the firewall setup.
- `penguin-signer.env.example`: the env file layout.

### 1. Create the Oracle Cloud account

1. Sign up at <https://signup.cloud.oracle.com/>. A credit card is required
   for identity verification. Always Free resources are not charged.
2. **Choose the home region carefully.** Always Free resources exist only in
   the home region, and it can't be changed later. Pick one near your users
   that has Ampere A1 capacity; less busy regions run out of capacity less
   often. A1 is not offered in South Korea North (Chuncheon).

### 2. Create the VM

In Compute > Instances > Create instance:

1. **Image**: Canonical Ubuntu 24.04 (the standard image, not "Minimal").
2. **Shape**: Ampere > `VM.Standard.A1.Flex`, with **1 OCPU and 6 GB** of
   memory. That is far more than this service needs. The Always Free A1
   allowance is 2 OCPUs and 12 GB in total (1,500 OCPU-hours and 9,000
   GB-hours per month, per
   <https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm>).
   If you get "Out of host capacity", try another availability domain or
   try again later.
3. **Networking**: create or choose a VCN with a public subnet, and keep
   "Assign a public IPv4 address" on.
4. **SSH keys**: paste your public key, for example `~/.ssh/id_ed25519.pub`.
5. **Advanced options > Management > Initialization script**: choose "Paste
   cloud-init script" and paste all of `deploy/cloud-init.yaml`.
6. **Boot volume**: the default (about 47-50 GB) is fine.
7. Create the instance and note its **public IP**. For example, `203.0.113.7`
   below means `203-0-113-7.sslip.io`.

cloud-init needs about 5-10 minutes for package upgrades, Caddy and rustup.
It is finished when `/var/lib/penguin-signer/cloud-init.done` exists:

```sh
ssh ubuntu@203.0.113.7 'sudo tail -n 5 /var/log/cloud-init-output.log; ls /var/lib/penguin-signer/'
```

### 3. Open ports 80 and 443 in the VCN security list

Oracle blocks these ports at two levels, and both have to be opened:

- **Cloud firewall (you do this)**: go to Networking > Virtual cloud networks >
  your VCN > Subnets > the public subnet > Security Lists > Default Security
  List > Add Ingress Rules. Add two rules, both with Source CIDR `0.0.0.0/0`,
  IP protocol TCP, and source port All:
  - destination port `80` (needed for Let's Encrypt and the HTTP-to-HTTPS redirect)
  - destination port `443`

  If the subnet uses a Network Security Group instead, add the same rules
  there. Leave the existing rule for port 22.
- **Host firewall (cloud-init does this)**: Oracle's Ubuntu images ship
  `/etc/iptables/rules.v4`, which rejects all inbound traffic except SSH.
  Oracle warns *not* to use ufw on these images: "Using UFW to edit rules
  might cause an instance not to boot"
  (<https://docs.oracle.com/en-us/iaas/Content/Compute/References/bestpracticescompute.htm>).
  The file also contains rules that protect the boot-volume iSCSI endpoints.
  For these reasons `open-web-ports.sh` doesn't use ufw. It adds `ACCEPT`
  lines for 80 and 443 to `rules.v4`, before the final `REJECT`, and reloads
  the file. It falls back to ufw (allowing only 22, 80 and 443) only on images
  without that file. Inbound traffic is still limited to 22, 80 and 443.

### 4. Deploy

From your machine, in the repo:

```sh
signer/deploy/deploy.sh ubuntu@203.0.113.7
# with your own domain later:
SIGNER_HOST=signer.example.org signer/deploy/deploy.sh ubuntu@203.0.113.7
```

The script does the following:

1. Copies `signer/` to the VM with rsync, leaving out `target/`.
2. Runs `cargo build --release --locked` on the VM. The first build takes a
   few minutes on 1 OCPU.
3. Installs `/usr/local/bin/penguin-signer`, the systemd unit, the
   Caddyfile and `/etc/caddy/penguin.env` (`SIGNER_HOST`).
4. Makes sure 80 and 443 are open, then restarts the service and Caddy.

For an IP address, `SIGNER_HOST` defaults to `<ip-with-dashes>.sslip.io`.
That name resolves to the VM's IP, so Caddy can get a Let's Encrypt
certificate for it. On the first deploy the script warns that the env file
is missing. That is expected; step 5 adds it.

### 5. Put the secrets in place

On the VM, run the following. The `read -s` prompts keep the secrets off the
screen and out of shell history, and `printf` is a shell builtin, so the
secrets never appear in a process list:

```sh
ssh ubuntu@203.0.113.7
read -rp  'Meeting SDK Client ID (key): '   k
read -rsp 'Meeting SDK Client Secret: '      s; echo
read -rsp 'Webhook Secret Token: '           w; echo
printf 'ZOOM_SDK_KEY=%s\nZOOM_SDK_SECRET=%s\nZOOM_WEBHOOK_SECRET=%s\n' "$k" "$s" "$w" \
  | sudo install -m 600 -o root -g root /dev/stdin /etc/penguin-signer.env
unset k s w
sudo systemctl restart penguin-signer
systemctl status penguin-signer --no-pager
```

The file is owned by root with mode 600. systemd reads it before the service
drops to the unprivileged `signer` user. Run the same commands again to
rotate a secret.

### 6. Check it

```sh
curl https://203-0-113-7.sslip.io/healthz          # ok
curl -s https://203-0-113-7.sslip.io/v1/signature \
  -H 'content-type: application/json' -d '{"meetingNumber":"123456789","role":0}'
```

The first HTTPS request can take a few seconds while Caddy gets the
certificate. If it fails, run `sudo journalctl -u caddy -n 50`. A common cause
is that ports 80 or 443 are still closed in the security list.

### 7. Point the app at it

The desktop app reads the signer's base URL from the environment variable
**`PENGUIN_SIGNER_URL`**. If that isn't set, it uses a default compiled into
the app. It then POSTs to `<base>/v1/signature`.

```sh
PENGUIN_SIGNER_URL=https://203-0-113-7.sslip.io penguin-for-zoom
```

Set the compiled default to the same URL when building releases.

### 8. Point Zoom's deauthorization webhook at it

In the Zoom Marketplace, open your app and go to Features > Access > Event
Subscriptions. Then:

1. Add a subscription with the **Event notification endpoint URL**
   `https://203-0-113-7.sslip.io/v1/zoom-webhook`.
2. Add the event **App Deauthorized** (`app_deauthorized`). It is under
   "App" or "Marketplace" depending on the console version.
3. Copy the subscription's **Secret Token** into `ZOOM_WEBHOOK_SECRET`
   (step 5), and restart the service.
4. Click **Validate**. Zoom sends `endpoint.url_validation` and expects
   our answer within 3 s. It revalidates every 72 hours, and after 6
   failed revalidations in a row it disables the subscription.

Zoom requires the endpoint to be an FQDN with a valid CA certificate. An
sslip.io name with a Let's Encrypt certificate meets that requirement, but
move to your own domain before review (PLAN.md §6).

## Updating

- **Code**: run `signer/deploy/deploy.sh ubuntu@<ip>` again. It rebuilds,
  swaps the binary in one step and restarts the service. The secrets are
  left untouched.
- **OS**: unattended-upgrades installs security updates every day and
  reboots at 04:00 (server time, UTC by default) when an update needs it.
  The service and Caddy start again on boot. To upgrade by hand, run
  `sudo apt update && sudo apt full-upgrade`.
- **Rust toolchain**: deploy.sh runs `rustup update stable` on every deploy.

## Logs

```sh
sudo journalctl -u penguin-signer -f            # service (JSON lines)
sudo journalctl -u penguin-signer --since today | grep -c '"outcome":"signed"'
sudo journalctl -u caddy -n 100                 # TLS / proxy
sudo fail2ban-client status sshd                # banned SSH sources
```

## Keeping the free VM alive (idle reclamation)

Oracle's rule
(<https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm>,
"Reclamation of Idle Compute Instances"):

> Idle Always Free compute instances may be reclaimed by Oracle. Oracle will
> deem virtual machine and bare metal compute instances as idle if, during a
> 7-day period, the following are true: CPU utilization for the 95th
> percentile is less than 20%; Network utilization is less than 20%; Memory
> utilization is less than 20% (applies to A1 shapes only).

This signer barely uses any CPU, memory or network, so the VM meets all three
"idle" conditions and could be reclaimed. You have three options:

1. **Upgrade the tenancy to Pay As You Go (recommended).** Oracle says that
   after the upgrade it "doesn't charge for Always Free resources ... and will
   only charge you for resource usage above the Always Free limits". It is
   commonly reported that idle reclamation only targets Free Tier
   (trial-converted) accounts. However, the docs page above does **not** say
   that paid accounts are exempt, so this is unconfirmed. The risk is an
   accidental charge if you later create resources beyond the free limits. A
   budget alert (Billing > Budgets, for example at 1 USD) reduces that risk.
2. **Generate light load on purpose.** For example, a systemd timer could
   keep CPU p95 above 20% (a low-priority `nice -n 19` busy loop with a duty
   cycle). **None is installed.** The trade-offs: it wastes energy, it
   defeats the purpose of the rule and could be treated as abuse, it slows the
   real service only a little (because of `nice`), and Oracle can change the
   thresholds at any time. Because the rule needs *all three* conditions,
   pushing just one metric (CPU) above 20% should be enough, but this is
   unconfirmed.
3. **Accept the risk.** If the VM is reclaimed, recreate it with the same
   cloud-init and run deploy.sh again. That takes about 15 minutes; then
   restore `/etc/penguin-signer.env`. The URL changes with the IP unless you
   use a reserved public IP or your own domain. Reserving a public IP is
   recommended either way, because otherwise the app's compiled-in URL
   breaks.

## Security notes

- The service runs as the unprivileged `signer` user under strict systemd
  sandboxing (see `deploy/penguin-signer.service`). It is reachable only
  through Caddy on localhost.
- Secrets live only in `/etc/penguin-signer.env` (root, 600). They are never
  logged, and their `Debug` output is redacted.
- The rate limiter and token cache are in memory and reset on restart. That
  is acceptable for a single instance.
- Webhook signatures are compared in constant time, and stale timestamps
  (more than 5 minutes) are rejected to stop replays.
