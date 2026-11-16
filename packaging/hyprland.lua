-- Hyprland (Lua config, 0.56+) snippets for Penguin for Zoom.
-- The window rule goes in ~/.config/hypr/hyprland.lua, the keys in ~/.config/hypr/bindings.lua.
-- The window class is penguin-zoom.

-- The join screen floats centred; tile it with the usual keys once in the meeting.
-- The screen never locks while the window is focused.
o.window("penguin-zoom", { float = true, center = true, size = { 1100, 800 }, idle_inhibit = "focus" })

-- Keys that work from anywhere on the desktop (SUPER + M is taken on Omarchy).
o.bind("SUPER + SHIFT + M", "Zoom: mute/unmute", "penguin-zoom --cmd mute-toggle")
o.bind("SUPER + SHIFT + L", "Zoom: leave meeting", "penguin-zoom --cmd leave")
