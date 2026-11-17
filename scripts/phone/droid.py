#!/usr/bin/env python3
"""droid: drive any Android app's UI over adb at near-human speed.

Engine (copy this file next to your app module; it has no app knowledge):
  * uiautomator2 agent on the phone, connected ONCE by a resident server: a UI
    read is ~0.16-0.2 s (stock `uiautomator dump` is ~2.3 s: it waits for an
    idle UI that a video app never reaches).
  * taps are fire-and-forget lines into one long-lived `adb shell` (~0 ms our
    side, lands ~60 ms later; `adb shell input tap` per call is ~120 ms).
  * no fixed sleeps: every step re-reads the screen back to back until what it
    needs is there (`until`), then acts.
  * phone animations are switched off while the server runs (saved first,
    restored on quit), so a sheet's first reported position is final.
  * a tap only goes to an element that is settled (not touching the bottom
    edge, and with animations on: same centre in two reads), and with
    expect= it is confirmed and re-tried.

Use:  dr <cmd> [args]           (the `dr` client starts the server on first use)
      uv run -q --with uiautomator2 python -I droid.py serve   (foreground)

  ui                         visible elements: text, desc, resource-id, bounds
  tap REGEX [TIMEOUT] [EXPECT] tap the first element whose text/desc matches
  wait REGEX [TIMEOUT]       wait for it
  gone REGEX [TIMEOUT]       wait for it to disappear
  back | home                key press
  launch PACKAGE             start an app's launcher activity
  text STRING                type into the focused field
  swipe up|down              scroll the middle of the screen
  shot PATH                  screenshot (PNG)
  animations on|off          restore / switch off phone animations
  ping | quit                server liveness / stop (restores animations)

App modules: `from droid import *`, define functions, add them to COMMANDS
(name -> fn(args)), then call cli(). Run them with
DROID_MODULE=/path/app.py dr <cmd> (the socket is named after the module).
Example: scripts/phone/zphone.py in ~/Projects/zoom-client.

Env: DROID_DEBUG=1 per-step timing to the server's stderr; DROID_TIME=1 adds
"[0.42s]" to each reply; DROID_KEEP_ANIMATIONS=1 leaves animations alone;
ANDROID_SERIAL picks the device.
"""
import io, os, re, shlex, signal, socket, subprocess, sys, time
import xml.etree.ElementTree as ET
import uiautomator2 as u2

NAME = "droid"
SOCK = os.environ.get("DROID_SOCK") or os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "droid.sock")
ANIM_SAVE = os.path.expanduser("~/.local/state/droid-animations")
ANIM_KEYS = ("window_animation_scale", "transition_animation_scale", "animator_duration_scale")


class Fail(Exception):
    pass


def fail(msg):
    raise Fail(msg)


def pick_serial():
    """One phone often shows up twice (the mDNS `adb-…._adb-tls-connect._tcp` entry and
    `ip:port`); uiautomator2 refuses to choose. Prefer USB, then ip:port, then the rest."""
    out = subprocess.run(["adb", "devices"], capture_output=True, text=True).stdout.splitlines()[1:]
    devs = [l.split()[0] for l in out if l.strip().endswith("\tdevice") and not l.startswith("emulator-")]
    if not devs:
        return None
    usb = [x for x in devs if ":" not in x and "._tcp" not in x]
    ipp = [x for x in devs if re.match(r"^\d+\.\d+\.\d+\.\d+:\d+$", x)]
    serial = (usb or ipp or devs)[0]
    os.environ["ANDROID_SERIAL"] = serial  # adb calls made by droid itself use it too
    return serial


class Dev:
    """The uiautomator2 device: connected once, reconnected after an error."""
    def __init__(self):
        self._d = None

    def reset(self):
        self._d = None

    def __getattr__(self, name):
        if self._d is None:
            self._d = u2.connect(os.environ.get("ANDROID_SERIAL") or pick_serial())
        return getattr(self._d, name)


d = Dev()
OUT = sys.stdout
T0 = time.time()


def log(*a):
    print(*a, file=OUT, flush=True)


def dbg(*a):
    if os.environ.get("DROID_DEBUG"):
        print(f"  {time.time() - T0:5.2f}", *a, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- read / act

def dump():
    """UI hierarchy XML. The agent's HTTP server sometimes drops a request
    right after (re)connecting (RemoteDisconnected): retry, reconnecting."""
    err = None
    for i in range(6):
        try:
            x = d.dump_hierarchy()
            dbg("read")
            return x
        except Exception as e:  # noqa: BLE001
            err = e
            dbg("read failed", type(e).__name__)
            if i >= 2:
                d.reset()
            time.sleep(0.2)
    raise err


_sh = None


def sh(cmd):
    """Fire-and-forget a shell command through one long-lived `adb shell`
    (commands run in order; nobody waits: callers re-read the screen)."""
    global _sh
    for _ in range(2):
        if _sh is None or _sh.poll() is not None:
            _sh = subprocess.Popen(["adb", "-s", d.serial, "shell"], stdin=subprocess.PIPE,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            _sh.stdin.write((cmd + "\n").encode())
            _sh.stdin.flush()
            return
        except (BrokenPipeError, OSError):
            _sh = None
    d.shell(cmd)


def click(x, y):
    sh(f"input tap {x} {y}")
    dbg("tap", x, y)


NAV_MAX = 3   # Back/Home/launch steps allowed per command
_nav = 0


def _navigate(what):
    """Count navigation steps: a recovery loop that keeps pressing Back and
    relaunching can fight the person holding the phone (it bounced between
    Zoom and Settings once). Past NAV_MAX in one command, stop and say so."""
    global _nav
    _nav += 1
    if _nav > NAV_MAX:
        fail(f"gave up: more than {NAV_MAX} navigation steps ({what}) in one command")


def key(name):
    if name in ("KEYCODE_BACK", "KEYCODE_HOME", "KEYCODE_APP_SWITCH"):
        _navigate(name)
    sh(f"input keyevent {name}")
    dbg("key", name)


class Snap:
    """One screen read, parsed once. Every decision reads a fresh Snap."""
    def __init__(self):
        self.nodes = []
        for n in ET.fromstring(dump()).iter("node"):
            a, b, c, e = map(int, re.findall(r"\d+", n.get("bounds")))
            if c > a and e > b:
                self.nodes.append((n, ((a + c) // 2, (b + e) // 2)))

    def id(self, rid):
        """(desc or text, centre) of the first node whose resource-id ends with rid."""
        for n, xy in self.nodes:
            if (n.get("resource-id") or "").endswith(rid):
                return n.get("content-desc") or n.get("text") or "", xy
        return None, None

    def find(self, pat):
        """(node, centre) of the first node whose text or content-desc matches pat (regex, any case)."""
        rx = re.compile(pat, re.I)
        for n, xy in self.nodes:
            if rx.search(n.get("text") or "") or rx.search(n.get("content-desc") or ""):
                return n, xy
        return None, None

    def target(self, pat):
        """Like find, but prefer a clickable match: a screen's title often
        repeats its button's label ("Start a meeting" title + button)."""
        rx = re.compile(pat, re.I)
        first = (None, None)
        for n, xy in self.nodes:
            if rx.search(n.get("text") or "") or rx.search(n.get("content-desc") or ""):
                if n.get("clickable") == "true":
                    return n, xy
                if first[0] is None:
                    first = (n, xy)
        return first

    def has(self, pat):
        return self.find(pat)[0] is not None

    def packages(self):
        return {n.get("package") for n, _ in self.nodes}

    def sig(self):
        """What is on screen, ignoring positions (changes when the screen does)."""
        return tuple((n.get("resource-id"), n.get("text"), n.get("content-desc")) for n, _ in self.nodes)


def until(pred, timeout):
    """Re-read the screen back to back until pred(snap) is truthy. Returns (value, last snap)."""
    end = time.time() + timeout
    while True:
        s = Snap()
        v = pred(s)
        if v or time.time() > end:
            return v, s


def wait(pat, timeout=5.0):
    _, s = until(lambda s: s.has(pat), timeout)
    return s.find(pat)


def gone(pat, timeout=5.0):
    return until(lambda s: not s.has(pat), timeout)[0]


def changed(before, timeout=1.5):
    """Wait until the screen differs from Snap `before` (after a key or launch)."""
    sig = before.sig()
    return until(lambda s: s.sig() != sig, timeout)[0]


SCREEN_H = None
ANIM_OFF = False  # animations(False) sets it: an element's first position is then final


def settled(s, pat, prev):
    """Centre of the element if it is safe to tap: not touching the bottom edge
    (a sheet sliding up reports stale halfway bounds for ~0.3 s), and, while
    animations are on, at the same centre as in the previous read."""
    global SCREEN_H
    if SCREEN_H is None:
        SCREEN_H = d.window_size()[1]
    n, xy = s.target(pat)
    if n is None:
        return None
    bottom = int(re.findall(r"\d+", n.get("bounds"))[3])
    ok = (ANIM_OFF or xy == prev[0]) and bottom < SCREEN_H - 4
    prev[0] = xy
    return xy if ok else None


def tap(pat, timeout=5.0, required=True, expect=None):
    """Tap the element as soon as it is on screen and settled. With expect (a
    regex for what the tap should bring up), confirm it within 1 s, else find
    the element again and re-tap (up to 3 times)."""
    end = time.time() + timeout
    for _ in range(3):
        prev = [None]
        xy, _ = until(lambda s: settled(s, pat, prev), max(0.0, end - time.time()))
        if xy is None:
            break
        click(*xy)
        if expect is None:
            return True
        ok, s = until(lambda s: s.has(expect), 1.0)
        if ok:
            return True
        dbg("tap: no", expect, "after", pat, "- retrying")
        if not s.has(pat):
            break
    if required:
        fail(f"not found: {pat}" + (f" (or no {expect} after it)" if expect else ""))
    return False


def launch(pkg):
    _navigate(f"launch {pkg}")
    sh(f"monkey -p {pkg} -c android.intent.category.LAUNCHER 1")
    dbg("launch", pkg)


def text(s):
    # `input text` needs spaces as %s and shell metacharacters quoted.
    sh("input text " + shlex.quote(s.replace(" ", "%s")))


def swipe(direction):
    w, h = d.window_size()
    y1, y2 = (int(h * 0.7), int(h * 0.35)) if direction == "up" else (int(h * 0.35), int(h * 0.7))
    sh(f"input swipe {w // 2} {y1} {w // 2} {y2} 150")


def shot(path):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "wb") as f:
        subprocess.run(["adb", "-s", d.serial, "exec-out", "screencap", "-p"], stdout=f, check=True)
    log(path)


PIN_FILE = os.path.expanduser("~/.config/droid/pin")  # mode 600; the owner's phone PIN


def _adbsh(*a):
    return subprocess.run(["adb", "-s", d.serial, "shell", *a], capture_output=True, text=True, timeout=10).stdout


def is_locked():
    return bool(re.search(r"\(current\).*deviceLocked=1", _adbsh("dumpsys", "trust")))


def unlock():
    """Unlock the phone with the PIN in PIN_FILE. One attempt only: repeated
    wrong PINs lock the phone out for minutes, so never loop this."""
    if not is_locked():
        return log("unlocked already")
    try:
        pin = open(PIN_FILE).read().strip()
    except OSError:
        fail(f"locked, and no PIN in {PIN_FILE}: ask the owner")
    _adbsh("input", "keyevent", "KEYCODE_WAKEUP")
    _adbsh("wm", "dismiss-keyguard")  # opens the PIN pad
    time.sleep(0.6)  # the bouncer has no dump to wait on while secure
    _adbsh("input", "text", pin)
    _adbsh("input", "keyevent", "KEYCODE_ENTER")
    end = time.time() + 4
    while time.time() < end:
        if not is_locked():
            return log("unlocked")
        time.sleep(0.25)
    fail("still locked after one PIN attempt (wrong PIN in the file, or the bouncer wasn't up); not retrying")


def ui():
    for n, _ in Snap().nodes:
        t, de = n.get("text") or "", n.get("content-desc") or ""
        if t or de:
            rid = (n.get("resource-id") or "").split("/")[-1]
            log(f"{t!r:42.42} {de!r:60.60} {rid:28.28} {n.get('bounds')} {'C' if n.get('clickable') == 'true' else ''}")


def animations(on):
    """Phone-wide animations off while we drive the phone; the owner's values
    are saved first (once) and put back by animations(True)."""
    global ANIM_OFF
    if not on:
        if not os.path.exists(ANIM_SAVE):
            os.makedirs(os.path.dirname(ANIM_SAVE), exist_ok=True)
            vals = {k: d.shell(f"settings get global {k}").output.strip() for k in ANIM_KEYS}
            if all(v in ("0", "0.0") for v in vals.values()):
                # Already all off: most likely left over from a run that died. Never
                # save that as the owner's choice; restore Android's default instead.
                vals = {k: "1.0" for k in ANIM_KEYS}
            with open(ANIM_SAVE, "w") as f:
                f.write("\n".join(f"{k}={v}" for k, v in vals.items()) + "\n")
        d.shell("; ".join(f"settings put global {k} 0" for k in ANIM_KEYS))
        ANIM_OFF = True
        log("animations off")
        return
    ANIM_OFF = False
    if not os.path.exists(ANIM_SAVE):
        log("animations: nothing saved, left as they are")
        return
    for line in open(ANIM_SAVE).read().split():
        k, v = line.split("=", 1)
        d.shell(f"settings delete global {k}" if v in ("", "null") else f"settings put global {k} {v}")
    os.unlink(ANIM_SAVE)
    log("animations restored")


# ---------------------------------------------------------------- commands

def _f(args, i, default):
    return float(args[i]) if len(args) > i else default


COMMANDS = {
    "ui": lambda a: ui(),
    "tap": lambda a: (tap(a[0], _f(a, 1, 5), expect=a[2] if len(a) > 2 else None), log("tapped", a[0])),
    "wait": lambda a: log("found") if wait(a[0], _f(a, 1, 5))[0] is not None else fail(f"not found: {a[0]}"),
    "gone": lambda a: log("gone") if gone(a[0], _f(a, 1, 5)) else fail(f"still there: {a[0]}"),
    "back": lambda a: key("KEYCODE_BACK"),
    "home": lambda a: key("KEYCODE_HOME"),
    "launch": lambda a: launch(a[0]),
    "text": lambda a: text(" ".join(a)),
    "swipe": lambda a: swipe(a[0] if a else "up"),
    "shot": lambda a: shot(a[0]),
    "animations": lambda a: animations(a[0] == "on"),
    "unlock": lambda a: unlock(),
    "locked": lambda a: log("locked" if is_locked() else "unlocked"),
}


def run(argv, out):
    """Run one command line; output goes to out. Returns the exit code."""
    global OUT, T0, _nav
    OUT, T0, _nav = out, time.time(), 0
    try:
        if not argv:
            log(sys.modules["__main__"].__doc__ or __doc__)
            return 0
        fn = COMMANDS.get(argv[0])
        if fn is None:
            fail(f"unknown command {argv[0]}")
        key("KEYCODE_WAKEUP")
        fn(argv[1:])
        return 0
    except Fail as e:
        log("FAIL", e)
        return 1
    except Exception as e:  # noqa: BLE001  (agent hiccup: reconnect next time)
        d.reset()
        log("FAIL", type(e).__name__, e)
        return 1
    finally:
        if os.environ.get("DROID_TIME"):
            log(f"[{time.time() - T0:.2f}s]")


def serve():
    """Resident server on a unix socket: one connection = one shell-quoted
    command line; the reply is its output plus a last line "rc=N"."""
    if os.path.exists(SOCK):
        os.unlink(SOCK)
    srv = socket.socket(socket.AF_UNIX)
    srv.bind(SOCK)
    srv.listen(4)
    signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))
    signal.signal(signal.SIGHUP, lambda *a: sys.exit(0))
    dump()  # connect the agent now, not on the first command
    keep = os.environ.get("DROID_KEEP_ANIMATIONS")
    if not keep:
        animations(False)
    try:
        while True:
            c, _ = srv.accept()
            with c:
                try:
                    line = c.makefile().readline().strip()
                    if line == "quit":  # restore before replying: the caller may read the settings next
                        if not keep:
                            buf = io.StringIO()
                            run(["animations", "on"], buf)
                            keep = True
                        c.sendall(b"rc=0\n")
                        break
                    if line in ("", "ping"):
                        c.sendall(b"rc=0\n")
                        continue
                    buf = io.StringIO()
                    rc = run(shlex.split(line), buf)
                    c.sendall(f"{buf.getvalue()}rc={rc}\n".encode())
                except Exception as e:  # noqa: BLE001  (client went away etc.)
                    print(f"{NAME}:", type(e).__name__, e, file=sys.stderr, flush=True)
    finally:
        if not keep:
            try:
                animations(True)
            except Exception as e:  # noqa: BLE001
                print(f"{NAME}: could not restore animations ({e}); saved in {ANIM_SAVE}",
                      file=sys.stderr, flush=True)
        if os.path.exists(SOCK):
            os.unlink(SOCK)


def cli():
    argv = sys.argv[1:]
    if argv[:1] == ["serve"]:
        serve()
        return
    sys.exit(run(argv, sys.stdout))


if __name__ == "__main__":
    cli()
