# Installing Penguin for Zoom (instructions for an AI agent)

You are installing Penguin for Zoom for a user on an Arch Linux machine. It is one program,
`penguin-zoom`: a Rust app that shows Zoom's Meeting SDK for Web in a WebKitGTK window. It is
built from this repo into an Arch package and installed with pacman. Follow these steps in
order. Do not use sudo without asking the user first, and show them each sudo command before you
run it. If a step fails, stop and explain why; don't retry in a loop or work around it. Only
report something as working if you checked it.

**Tell the user this before you start.** The app is not released yet. It is waiting for Zoom's
app review, and its signing service is not running. Until both are done, the app installs and
opens, but sign-in and joining a meeting only work for the developer's own Zoom account. Ask the
user whether they still want it installed. Do not try to get around this: don't create Zoom
credentials, and don't ask the user for a Zoom secret, key or password.

## 1. Look before you change anything

```sh
. /etc/os-release && echo "$ID ${ID_LIKE:-}"
command -v pacman makepkg
pacman -Q penguin-zoom 2>/dev/null
```

- The package is for Arch and Arch-based distros (`ID` or `ID_LIKE` contains `arch`). On anything
  else, stop and tell the user: there is no package for their distro yet.
- If `pacman -Q` prints a version, the app is already installed. Go to **Updating**.
- If `makepkg` is missing, `base-devel` isn't installed; step 2 installs it.

## 2. Install the build tools (needs sudo)

```sh
sudo pacman -S --needed base-devel git
```

Everything else is installed by `makepkg` in step 3, from Arch's own repos: the build tools
`cargo` (the `rust` package, 1.85 or newer) and `npm`, and the runtime packages `webkit2gtk-4.1`,
`gtk3`, `gst-plugins-good`, `gst-plugins-bad`, `gst-libav`, `gst-plugin-pipewire`, `libpulse`,
`libsecret` and `xdg-utils`.

Optional, ask the user: `xdg-desktop-portal-hyprland` (or the portal backend for their desktop)
for screen sharing on Wayland, and `pipewire-pulse` for choosing speakers from the app.

## 3. Build and install the package (needs sudo for the install)

```sh
git clone https://github.com/vaknin/penguin-zoom ~/.local/src/penguin-zoom
cd ~/.local/src/penguin-zoom/packaging
makepkg -si
```

`makepkg -si` asks for the sudo password twice: once to install missing dependencies, once to
install the finished package. Tell the user before you run it. The build takes a few minutes and
runs the tests.

The build downloads Zoom's Meeting SDK from npm (`@zoom/meetingsdk`, the version in the
PKGBUILD). It is not in the repo because Zoom's terms govern its redistribution, so the build
needs a network connection.

If `cargo` or `npm` on this machine come from a version manager (mise, rustup, nvm) and not from
pacman, `makepkg -s` will install the `rust` and `npm` packages next to them. To use the ones
already on PATH, run `makepkg -di` instead (`-d` skips the dependency check), but only if the
runtime packages listed in step 2 are already installed.

## 4. Open Zoom links in Penguin (optional, changes a default: ask first)

The package registers the app for `zoommtg://` and `zoomus://` links. If another Zoom app is
installed, links may still open there. Check the current handler and tell the user what it is:

```sh
xdg-mime query default x-scheme-handler/zoommtg
```

If the user wants Penguin to open Zoom links:

```sh
xdg-mime default penguin-zoom.desktop x-scheme-handler/zoommtg x-scheme-handler/zoomus
```

Note the previous handler (often `Zoom.desktop`) so it can be restored when uninstalling.

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
pacman -Q penguin-zoom
ls /usr/share/penguin-zoom/assets/zoom-sdk/VERSION
penguin-zoom
```

`pacman -Q` should print `penguin-zoom 0.1.0-1` or newer, and the `VERSION` file should exist
(if it doesn't, the SDK download failed during the build: check the network and rebuild). The
last command opens a window that says "Open a Zoom link to join". If no window opens, run it
from a terminal and read the output; the app serves its interface on `127.0.0.1:53682`, so
another program on that port stops it from starting (`ss -ltnp | grep 53682`).

You can't check a real meeting unless the user is the developer (see the note at the top). Say
so plainly rather than reporting that joining works.

## 7. Tell the user how to use it

Start **Penguin for Zoom** from the app launcher, or run `penguin-zoom`. Then:

1. Sign in once per start: press `,` for Settings, then **Sign in** under Account. Zoom's own
   sign-in page opens in the window. The sign-in is kept only while the app runs.
2. Click a Zoom meeting link, or copy one and press Ctrl V in the window. From a terminal:
   `penguin-zoom "https://zoom.us/j/123456789?pwd=…"`.
3. Check the camera and microphone on the join screen and press **Join**.

In the meeting: `m` mute, `v` camera, `s` share screen, `c` chat, `p` people, `g` gallery or
speaker view, `d` devices, Ctrl Shift L leave. Closing the window also leaves.

## Updating

```sh
cd ~/.local/src/penguin-zoom && git pull && cd packaging && makepkg -si
```

## Uninstalling

Ask the user to sign out first (Settings, Account, **Sign out**), which revokes the app's token
with Zoom. Then:

```sh
sudo pacman -R penguin-zoom
rm -r ~/.config/penguin-zoom
rm -rf ~/.local/src/penguin-zoom
```

If you changed the link handler in step 4, set the previous one again, for example
`xdg-mime default Zoom.desktop x-scheme-handler/zoommtg x-scheme-handler/zoomus`. If you added
Hyprland lines in step 5, remove them. The user can also remove the app from their Zoom account
at https://marketplace.zoom.us/user/installed. Nothing else is left behind: the app keeps no
data besides its settings file.
