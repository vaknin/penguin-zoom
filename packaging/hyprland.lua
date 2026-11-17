-- Optional Hyprland (Lua config, 0.56+) snippets for Penguin for Zoom. The app needs none of
-- this: it opens fullscreen by itself (F11 toggles it) on any desktop, and the mute/leave
-- commands can be bound in any desktop's keyboard settings.
-- The window rule goes in ~/.config/hypr/hyprland.lua, the keys in ~/.config/hypr/bindings.lua.
-- The window class is penguin-zoom.

-- The screen never locks while the window is focused.
o.window("penguin-zoom", { idle_inhibit = "focus" })

-- Keys that work from anywhere on the desktop.
o.bind("SUPER + SHIFT + M", "Zoom: mute/unmute", "penguin-zoom --cmd mute-toggle")
o.bind("SUPER + SHIFT + L", "Zoom: leave meeting", "penguin-zoom --cmd leave")
