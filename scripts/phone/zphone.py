#!/usr/bin/env python3
"""zphone: the Zoom app on the phone, driven at near-human speed.

Built on droid.py (same folder; canonical copy in the android-ui-driver skill):
resident uiautomator2 server, ~0.2 s screen reads, fire-and-forget taps, no
fixed sleeps, phone animations off while it runs. Use through `zp`:

  zp state                   mic=on|off cam=on|off sharing=yes|no
  zp mic on|off              set my mic (no-op if already so; confirmed)
  zp cam on|off              set my camera
  zp meeting                 bring the running meeting to the front
  zp share / stop-share      share the whole screen / stop
  zp make-host NAME          participants -> NAME -> Make host -> confirm
  zp admit NAME|all          admit from the waiting room
  zp allow-share             Host tools: let participants share
  zp start                   start a new meeting from the home screen
  zp info                    print "ID PASSCODE" (and write $S/meeting.txt)
  zp leave                   leave the meeting (host: end it for all)
  zp shot NAME               screenshot to $S/phone/NAME.png
  zp quit                    stop the server, restore phone animations
plus droid's generic commands: ui, tap, wait, gone, back, home, launch, text, swipe.
"""
import os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import droid
from droid import (COMMANDS, Snap, click, changed, d, dbg, fail, key, launch, log,
                   gone, sh, tap, until, wait)

droid.NAME = "zphone"
PKG = "us.zoom.videomeetings"
# Zoom pop-ups that cover the meeting (upsells, tips): tapped away on sight.
POPUPS = r"^Not now$|^Got it$|^Maybe later$|^Later$|^No thanks$"
COOLDOWN = r"Start your next meeting in"
AUDIO, VIDEO ="meeting_toolbar_audio", "meeting_toolbar_video"
PREVIEW = r"^Always show this preview when joining$"


def in_meeting(s):
    # Zoom's home screen keeps the meeting in a floating mini-window that also
    # has an activeVideoContainer; "Back to meeting" there means we're not in it.
    if s.id(AUDIO)[0] is not None:
        return True
    return s.id("activeVideoContainer")[0] is not None and not s.has(r"^Back to meeting")


def wait_meeting(timeout):
    return until(in_meeting, timeout)[0]


def meeting():
    """Bring the meeting to the front from wherever the phone is: read the
    screen, take the one obvious step, read again. Stops as soon as it is
    clear there is no meeting (Zoom's home without "Back to meeting"), never
    launches Zoom twice, and droid caps Back/launch steps per command."""
    import time
    end = time.time() + 6
    last, launched = None, False
    while time.time() < end:
        s = Snap()
        popup = s.find(POPUPS)
        if in_meeting(s) and popup[0] is None:
            return
        n, xy = popup if popup[0] is not None else s.find(r"^Back to meeting")
        if n is not None:
            if xy != last:  # tapped already: give it a read to take effect
                click(*xy)
                dbg("meeting: tapped", n.get("text") or n.get("content-desc"))
                last = xy
            continue
        last = None
        if PKG in s.packages():
            if zoom_home(s):
                fail("no meeting on the phone (Zoom is on its home screen)")
            key("KEYCODE_BACK")  # a sheet or panel over the meeting
        elif launched:
            fail("no meeting on the phone (Zoom did not come to the front)")
        else:
            launch(PKG)
            launched = True
        changed(s)
    fail("no meeting on the phone")


def zoom_home(s):
    """Zoom's main screen (tabs Home/Chat/...), not a meeting or a panel over one."""
    return s.has(r"^Home$") and s.has(r"^Chat") and not in_meeting(s)


def toolbar():
    """The bottom toolbar, shown (a tap on the video toggles it). Returns its Snap."""
    s = Snap()
    if panel_open(s):
        close_panel()
        s = Snap()
    if s.id(AUDIO)[0] is not None:
        return s
    if not in_meeting(s) or s.has(POPUPS):
        meeting()
        s = Snap()
        if s.id(AUDIO)[0] is not None:
            return s
    for attempt in range(3):
        if attempt == 2:
            # A full-screen panel (Apps, Participants…) can cover the meeting
            # while its video stays in the tree: close it with one Back.
            key("KEYCODE_BACK")
            changed(s)
        click(540, 700)
        ok, s = until(lambda s: s.id(AUDIO)[0] is not None, 1.2)
        if ok:
            return s
    fail("toolbar did not show")


def more(item, expect=None):
    """Toolbar -> More -> item."""
    s = toolbar()
    click(*s.find(r"^More, button")[1])
    # Zoom's More sheet slides up even with the phone's animations off (a tap
    # on the first-read position hit "Apps" below the participants button):
    # wait until the item is at the same place in two reads in a row.
    prev = [None]

    def still(s):
        xy = s.target(item)[1]
        ok = xy is not None and xy == prev[0]
        prev[0] = xy
        return ok
    until(still, 3)
    if tap(item, 3, required=False, expect=expect):
        return
    droid.swipe("up")
    tap(item, 2, expect=expect)


def state():
    s = toolbar()
    a, v = s.id(AUDIO)[0] or "", s.id(VIDEO)[0] or ""
    mic = "on" if a.startswith("Mute") else "off" if a.startswith("Unmute") else "?"
    cam = "on" if v.startswith("Stop") else "off" if v.startswith("Start") else "?"
    log(f"mic={mic} cam={cam} sharing={'yes' if s.has(r'^Stop share') else 'no'}")


def set_toggle(rid, want_on, on_prefix, off_prefix, what):
    """Set a toolbar toggle; its desc names the action ("Mute my audio" = mic is on)."""
    s = toolbar()
    desc, xy = s.id(rid)
    word = "on" if want_on else "off"
    if desc.startswith(on_prefix) == want_on:
        log(f"{what} already {word}")
        return
    click(*xy)
    want = on_prefix if want_on else off_prefix
    _, s = until(lambda s: (s.id(rid)[0] or "").startswith(want) or s.id(rid)[0] is None, 4)
    desc = s.id(rid)[0]
    if desc is None:  # the toolbar hid itself: show it and look once more
        desc = toolbar().id(rid)[0] or ""
    if not desc.startswith(want):
        fail(f"{what} did not change (desc: {desc!r})")
    log(f"{what} {word}")


def share():
    more(r"^Start share, button", expect=r"^Screen$")
    tap(r"^Screen$")
    # Android's screen-capture dialog: pick the entire screen if asked, then start.
    # Zoom (2026-11) first asks itself: title "Share screen", plain-text options
    # "Share entire screen" / "Share specific app" (not clickable, so tap()
    # would hit the same-named title of the next dialog). Pick the screen.
    if wait(r"^Share specific app$|^Share your screen with Zoom\?$", 5)[0] is not None and Snap().has(r"^Share specific app$"):
        tap(r"^Share entire screen$", 3, expect=r"^Share your screen with Zoom\?$")
    n, _ = wait(r"^Share entire screen$|^Entire screen$|^A single app$|^Share one app$|^Start now$|^Share screen$", 5)
    if n is not None and re.search(r"single app|one app", (n.get("text") or ""), re.I):
        tap(r"single app|one app", 2)
        tap(r"^Share entire screen$|^Entire screen$", 3)
    tap(r"^Share screen$|^Start now$|^Start$", 5)
    if wait(r"Stop share|Stop sharing|sharing your screen", 8)[0] is None:
        fail("share did not start (no stop button)")
    log("sharing")


def stop_share():
    # While sharing, Zoom's meeting screen shows the shared screen itself with
    # the toolbar hidden; "Stop share" is in the More sheet (2026-11-17).
    launch(PKG)
    if not tap(r"^Stop share|Stop sharing", 2, required=False):
        more(r"^Stop share, button")
    if not gone(r"^Stop share|Stop sharing|sharing your screen", 5):
        fail("share did not stop")
    log("share stopped")


def participants():
    # 2026-11: the list opens in a split view titled just "Participants".
    more(r"participants?, button$", expect=r"^Participants( \(\d+\))?$|^Invite$|Mute all")


PANEL_IDS = ("pull_bar_container", "dragHandleView", "zm_zapp_back_button", "tv_topbar_top_title")


def panel_open(s):
    """A panel or sheet over the meeting. Zoom keeps the meeting video in a strip
    above its split-view panels, so in_meeting() alone is true with one open
    (2026-11-17: allow-share left Participants settings open, which hid the
    waiting-room prompt and the toolbar for a whole test run)."""
    return any(s.id(i)[0] is not None for i in PANEL_IDS) or s.has(r"^Participants( \(\d+\))?$")


def close_panel():
    for _ in range(4):
        s = Snap()
        if in_meeting(s) and not panel_open(s):
            return
        # The panel's own Close/Back button first (Back key presses count
        # towards droid.NAV_MAX, and stacked panels need several).
        _, xy = s.id("ibtn_topbar_left_close")
        if xy is None:
            _, xy = s.id("zm_zapp_back_button")
        if xy is None:
            n, xy = s.target(r"^Close$|^Back$")
            if n is not None and n.get("clickable") != "true":
                xy = None
        if xy is not None:
            click(*xy)
        else:
            key("KEYCODE_BACK")
        changed(s, 1.0)
    if panel_open(Snap()):
        fail("could not close the panel over the meeting")


def tap_row(name, expect, timeout=6):
    """Tap a participant's row in the open list. By resource id: the same name
    is also a label on the meeting video strip above the list, and that one
    comes first on screen (2026-11-17: make-host tapped the video)."""
    def row(s):
        for n, xy in s.nodes:
            if (n.get("resource-id") or "").endswith("txtScreenName") and (n.get("text") or "") == name:
                return xy
    for _ in range(3):
        xy, _ = until(row, timeout)  # the list shows "Loading..." first
        if xy is None:
            return False
        click(*xy)
        if until(lambda s: s.has(expect), 1.5)[0]:
            return True
    return False


def make_host(name):
    participants()
    if not tap_row(name, r"^Make host$"):
        fail(f"{name} is not in the participants list (or no Make host for them)")
    tap(r"^Make host$")
    tap(r"^(Change host|Change|Make host|Yes|OK)$", 3, required=False)
    close_panel()
    log(f"made {name} host")


def admit(name):
    participants()
    if name == "all":
        ok = tap(r"^Admit all$", 5, required=False) or tap(r"^Admit$", 1, required=False)
    else:
        ok = tap_row(name, r"^Admit$", 5) and tap(r"^Admit$", 2, required=False)
    close_panel()
    if not ok:
        fail(f"could not admit {name}")
    log("admitted")


def allow_share():
    more(r"^Host tools, button")
    tap(r"^Participants$", 3, required=False)
    n, xy = wait(r"^Share screen$", 5)
    if n is None:
        fail("no Share screen row")
    row_y, target = xy[1], None
    for m, mxy in Snap().nodes:  # the switch on the same row
        if m.get("checkable") == "true":
            b, e = map(int, re.findall(r"\d+", m.get("bounds"))[1::2])
            if b <= row_y <= e:
                target = (m.get("checked") == "true", mxy)
                break
    if target is None:
        click(925, row_y)
        log("participant sharing: tapped switch (state unknown)")
    elif target[0]:
        log("participant sharing: already on")
    else:
        click(*target[1])
        log("participant sharing: turned on")
    close_panel()


def start():
    launch(PKG)
    tap(POPUPS, 1.5, required=False)  # e.g. the upgrade offer after a 40-minute meeting
    ok, s = until(lambda s: in_meeting(s) or s.has(r"^Meet$|^New meeting|^Start a meeting|^Back to meeting"), 6)
    if in_meeting(s) or s.has(r"^Back to meeting"):
        log("already in a meeting")
        return
    tap(r"^Meet, button$|^Meet$|^New meeting|^Start a meeting", 4, required=False)
    # Zoom 2026-11: "Meet" opens a sheet whose title and button both say "Start
    # a meeting"; the title comes first in the dump, so tap the button by id.
    _, xy = until(lambda s: s.id("btnStartMeeting")[1], 6)[1].id("btnStartMeeting")
    if xy:
        click(*xy)
    else:
        tap(r"^Start$|^Start a meeting$|^Start meeting$", 6)
    # Zoom (2026-11) may show a camera/mic preview with its own Start button
    # ("Always show this preview when joining"); press that one too.
    _, s = until(lambda s: s.id(AUDIO)[0] is not None or s.has(COOLDOWN) or s.has(PREVIEW), 20)
    if s.has(PREVIEW):
        tap(r"^Start$", 4)
    # The joining screen already looks like a meeting: success only once the
    # toolbar's mic button (or the meeting's video area) exists. Free plan:
    # after a 40-min meeting Zoom makes you wait ("Start your next meeting in
    # N minute(s)").
    _, s = until(lambda s: (in_meeting(s) and not s.has(PREVIEW)) or s.has(COOLDOWN), 20)
    n, _ = s.find(COOLDOWN)
    if n is not None:
        mins = re.search(r"(\d+)\s*minute", n.get("text") or "")
        tap(r"^CANCEL$|^Cancel$", 2, required=False)
        fail(f"Zoom free-plan cooldown: next meeting in {mins.group(1) if mins else '?'} min")
    if not in_meeting(s) or s.has(PREVIEW):
        fail("meeting did not start")
    log("meeting started")


def info():
    more(r"^Meeting info, button", expect=r"^Meeting ID$")
    _, s = until(lambda s: s.has(r"^Passcode$"), 3)
    texts = [n.get("text") or "" for n, _ in s.nodes]

    def after(label):
        for i, t in enumerate(texts):
            if t == label:
                return next((u.strip() for u in texts[i + 1:] if u.strip()), "")
        return ""
    mid, pw = after("Meeting ID").replace(" ", ""), after("Passcode")
    close_panel()
    if not re.fullmatch(r"\d{9,11}", mid):
        fail(f"could not read meeting ID ({mid!r})")
    log(f"{mid} {pw}")
    if os.environ.get("S"):
        with open(os.path.join(os.environ["S"], "meeting.txt"), "w") as f:
            f.write(f"{mid} {pw}\n")


def leave():
    toolbar()
    tap(r"^End, button|^Leave, button")
    tap(r"^End meeting for all$|^Leave meeting$", 4)
    log("left")


COMMANDS.update({
    "meeting": lambda a: (meeting(), log("in meeting")),
    "state": lambda a: state(),
    # Debug: open the More sheet and print what is on it.
    "more-ui": lambda a: (click(*toolbar().find(r"^More, button")[1]), wait(r"Meeting info", 3), droid.ui()),
    "mic": lambda a: set_toggle(AUDIO, a[0] == "on", "Mute", "Unmute", "mic"),
    "cam": lambda a: set_toggle(VIDEO, a[0] == "on", "Stop", "Start", "cam"),
    "share": lambda a: share(),
    "stop-share": lambda a: stop_share(),
    "make-host": lambda a: make_host(a[0]),
    "admit": lambda a: admit(a[0] if a else "all"),
    "allow-share": lambda a: allow_share(),
    "start": lambda a: start(),
    "info": lambda a: info(),
    "leave": lambda a: leave(),
    "shot": lambda a: droid.shot(os.path.join(os.environ.get("S", "."), "phone", a[0] + ".png")),
})

if __name__ == "__main__":
    droid.cli()
