# Installing Penguin for Zoom (instructions for an AI agent)

You are installing Penguin for Zoom for a user on an Arch Linux machine. It is one program,
`penguin-zoom`: a Rust app that shows Zoom's Meeting SDK for Web in a WebKitGTK window. It is
built from this repo and installed for the current user only, in their home folder, by
`scripts/install-user.sh`. There is no prebuilt package. Follow these steps in order. Do not use
sudo without asking the user first, and show them each sudo command before you run it. If a step
fails, stop and explain why; don't retry in a loop or work around it. Only report something as
working if you checked it.

**Tell the user this before you start.** The app is waiting for Zoom's app review. Until Zoom
approves it, the app installs, opens and signs in, but joining a meeting only works for meetings
of the developer's own Zoom account. Ask the user whether they still want it installed. Do not try
to get around this: don't create Zoom credentials, and don't ask the user for a Zoom secret, key
or password.

## 1. Look before you change anything

```sh
. /etc/os-release && echo "$ID ${ID_LIKE:-}"
command -v pacman cargo npm git
ls ~/.local/bin/penguin-zoom ~/.local/src/penguin-zoom 2>/dev/null
```

- The steps are for Arch and Arch-based distros (`ID` or `ID_LIKE` contains `arch`). On anything
  else, stop and tell the user: there are no install steps for their distro yet.
- If `~/.local/bin/penguin-zoom` exists, the app is already installed. Go to **Updating**.

## 2. Install the build tools and libraries (needs sudo)

```sh
sudo pacman -S --needed base-devel git rust npm webkit2gtk-4.1 gtk3 gst-plugins-good \
  gst-plugins-bad gst-libav gst-plugin-pipewire libpulse libsecret xdg-utils
```

`cargo` must be 1.85 or newer (`cargo --version`). If `cargo` or `npm` already come from a
version manager (mise, rustup, nvm) and are new enough, leave `rust` and `npm` out of the command.

The app keeps the user signed in through the Secret Service (for example GNOME Keyring). If no
keyring runs on the machine, tell the user they will have to sign in after every start.

Optional, ask the user: `xdg-desktop-portal-hyprland` (or the portal backend for their desktop)
for screen sharing on Wayland, and `pipewire-pulse` for choosing speakers from the app.

## 3. Build and install (no sudo)

```sh
git clone https://github.com/vaknin/penguin-zoom ~/.local/src/penguin-zoom
~/.local/src/penguin-zoom/scripts/install-user.sh
```

The build takes a few minutes. It downloads Zoom's Meeting SDK from npm (`@zoom/meetingsdk`) into
`assets/zoom-sdk/`; the SDK is not in the repo because Zoom's terms govern its redistribution, so
the build needs a network connection.

The script installs:

- `~/.local/bin/penguin-zoom`, the program (`~/.local/bin` must be on `PATH`),
- `~/.local/share/penguin-zoom`, its files and Zoom's SDK,
- a launcher and icon under `~/.local/share`.

## 4. Zoom links

The script makes Penguin the handler for `zoommtg://` and `zoomus://` links, which replaces the
previous handler. Before running step 3, note the current one so it can be restored when
uninstalling, and tell the user:

```sh
xdg-mime query default x-scheme-handler/zoommtg
```

## 5. Desktop-wide keys on Hyprland (optional, edits the user's config: ask first)

While it runs, the app takes commands from anywhere:

```sh
penguin-zoom --cmd mute-toggle
penguin-zoom --cmd camera-toggle
penguin-zoom --cmd leave
penguin-zoom --cmd raise
```

`packaging/hyprland.lua` in the repo has a window rule (the join screen floats centred, and the
screen doesn't lock while the window is focused) and two bindings, SUPER+SHIFT+M for mute and
SUPER+SHIFT+L for leave. It is written for Hyprland's Lua config (0.56 or newer) with Omarchy's
helpers. Show the user the lines and where they would go before adding them, check the keys
aren't already bound, and on another setup write the equivalent in the user's own config style.
The window class is `penguin-zoom`.

## 6. Check it works

```sh
command -v penguin-zoom
ls ~/.local/share/penguin-zoom/assets/zoom-sdk/VERSION
git -C ~/.local/src/penguin-zoom describe --always
penguin-zoom
```

`command -v` should print `~/.local/bin/penguin-zoom` (expanded), and the `VERSION` file should
exist (if it doesn't, the SDK download failed: check the network and run the script again). The
last command opens a window that says "Open a Zoom link to join". If no window opens, run it from
a terminal and read the output; the app serves its interface on `127.0.0.1:53682`, so another
program on that port stops it from starting (`ss -ltnp | grep 53682`).

You can't check a real meeting unless it belongs to the developer's account (see the note at the
top). Say so plainly rather than reporting that joining works.

## 7. Tell the user how to use it

Start **Penguin for Zoom** from the app launcher, or run `penguin-zoom`. Then:

1. Sign in once: press `,` for Settings, then **Sign in** under Account. Zoom's own sign-in page
   opens in the default web browser. After **Allow**, the browser tab says you are signed in and
   Settings shows "Signed in as" your name and email. The sign-in is kept in the system keyring,
   so it lasts across restarts until you sign out.
2. Click a Zoom meeting link, or copy one and press Ctrl V in the window. From a terminal:
   `penguin-zoom "https://zoom.us/j/123456789?pwd=…"`.
3. Check the camera and microphone on the join screen and press **Join**.

In the meeting: `m` mute, `v` camera, `s` share screen, `c` chat, `p` people, `g` gallery or
speaker view, `d` devices, Ctrl Shift L leave. Closing the window also leaves.

## Updating

```sh
git -C ~/.local/src/penguin-zoom pull
~/.local/src/penguin-zoom/scripts/install-user.sh
```

If the app is running, restart it to use the new version.

## Uninstalling

Ask the user to sign out first (Settings, Account, **Sign out**), which revokes the app's token
with Zoom and deletes the saved sign-in from the keyring. Then:

```sh
~/.local/src/penguin-zoom/scripts/install-user.sh --remove
rm -r ~/.config/penguin-zoom
rm -rf ~/.local/src/penguin-zoom
```

Set the previous link handler from step 4 again, for example
`xdg-mime default Zoom.desktop x-scheme-handler/zoommtg x-scheme-handler/zoomus`. If you added
Hyprland lines in step 5, remove them. The user can also remove the app from their Zoom account
at https://marketplace.zoom.us/user/installed. Nothing else is left behind: besides its settings
file and the keyring item that Sign out deletes, the app keeps no data.
