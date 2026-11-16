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
                   sh, tap, until, wait)

droid.NAME = "zphone"
PKG = "us.zoom.videomeetings"
# Zoom pop-ups that cover the meeting (upsells, tips): tapped away on sight.
POPUPS = r"^Not now$|^Got it$|^Maybe later$|^Later$|^No thanks$"
COOLDOWN = r"Start your next meeting in"
AUDIO, VIDEO ="meeting_toolbar_audio", "meeting_toolbar_video"


def in_meeting(s):
    return s.id("activeVideoContainer")[0] is not None or s.id(AUDIO)[0] is not None


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
    if s.id(AUDIO)[0] is not None:
        return s
    if not in_meeting(s) or s.has(POPUPS):
        meeting()
        s = Snap()
        if s.id(AUDIO)[0] is not None:
            return s
    for _ in range(2):
        click(540, 700)
        ok, s = until(lambda s: s.id(AUDIO)[0] is not None, 1.2)
        if ok:
            return s
    fail("toolbar did not show")


def more(item, expect=None):
    """Toolbar -> More -> item."""
    s = toolbar()
    click(*s.find(r"^More, button")[1])
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
    n, _ = wait(r"^Share entire screen$|^Entire screen$|^A single app$|^Share one app$|^Start now$|^Share screen$", 5)
    if n is not None and re.search(r"single app|one app", (n.get("text") or ""), re.I):
        tap(r"single app|one app", 2)
        tap(r"^Share entire screen$|^Entire screen$", 3)
    tap(r"^Share screen$|^Start now$|^Start$", 5)
    if wait(r"Stop share|Stop sharing|sharing your screen", 8)[0] is None:
        fail("share did not start (no stop button)")
    log("sharing")


def stop_share():
    launch(PKG)
    if not tap(r"^Stop share|Stop sharing", 4, required=False):
        meeting()
        tap(r"^Stop share|Stop sharing", 3)
    log("share stopped")


def participants():
    more(r"participants?, button$", expect=r"Participants \(\d+\)|^Invite$|Mute all")


def close_panel():
    for _ in range(4):
        s = Snap()
        if in_meeting(s):
            return
        key("KEYCODE_BACK")
        changed(s, 1.0)


def make_host(name):
    participants()
    tap(re.escape(name), expect=r"^Make host$")
    tap(r"^Make host$")
    tap(r"^(Change host|Change|Make host|Yes|OK)$", 3, required=False)
    close_panel()
    log(f"made {name} host")


def admit(name):
    participants()
    if name == "all":
        ok = tap(r"^Admit all$", 5, required=False) or tap(r"^Admit$", 1, required=False)
    else:
        ok = tap(re.escape(name), 5, required=False, expect=r"^Admit$") and tap(r"^Admit$", 2, required=False)
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
    ok, s = until(lambda s: in_meeting(s) or s.has(r"^Meet$|^New meeting|^Start a meeting|^Back to meeting"), 6)
    if in_meeting(s) or s.has(r"^Back to meeting"):
        log("already in a meeting")
        return
    tap(r"^Meet$|^New meeting|^Start a meeting", 4, required=False)
    tap(r"^Start$|^Start a meeting$|^Start meeting$", 6)
    # The joining screen already looks like a meeting: success only once the
    # toolbar's mic button exists. Free plan: after a 40-min meeting Zoom makes
    # you wait ("Start your next meeting in N minute(s)").
    _, s = until(lambda s: s.id(AUDIO)[0] is not None or s.has(COOLDOWN), 20)
    n, _ = s.find(COOLDOWN)
    if n is not None:
        mins = re.search(r"(\d+)\s*minute", n.get("text") or "")
        tap(r"^CANCEL$|^Cancel$", 2, required=False)
        fail(f"Zoom free-plan cooldown: next meeting in {mins.group(1) if mins else '?'} min")
    if s.id(AUDIO)[0] is None:
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
