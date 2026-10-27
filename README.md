<img src="https://raw.githubusercontent.com/Visiolite-com/xp-master-ha/main/custom_components/netroni/brand/logo.png" alt="Netroni" height="48">

# Netroni XP-Master for Home Assistant

Control the lights of a Visiolite **Netroni XP-Master** installation from Home Assistant. Every
output of every XP-Mini becomes a light you can name, put in an area, group and automate. Changes
show up instantly, both ways, and everything runs locally: no cloud.

## What you get

- **Lights.** Each XP-Mini output is a dimmable light. A port can also be set up as **tunable
  white**: its two outputs then become one light with a colour temperature, with the warm and
  cool range you choose.
- **Groups.** Lights dimmed together, also across XP-Minis. Each light keeps its own level; the
  group dims them all.
- **The Netroni panel** in the sidebar, for setting up an installation:
  - *Installation:* every XP-Mini and its lights, online status, names and areas. A port that
    identifies itself lights up in the panel, so lights are quick to find and name.
  - *Groups*, *DMX Output* (live levels) and *Matter* (pair the lights with Apple Home,
    Google Home, SmartThings and other Matter apps).
  - *Remote Access:* let another Home Assistant on your network control this XP-Master, paired
    with a six-digit code.
- **XP-Mini care.** Restart or factory reset an XP-Mini. When one is replaced, the new one takes
  over the lights, names, areas and groups of the old one, so automations keep working
  (Settings → Repairs offers it).
- **Updates and backups.** New XP-Master software shows under Settings → Updates and installs
  with one click. The XP-Master's configuration is included in Home Assistant backups.

## Install

1. In HACS, open the menu → *Custom repositories*, add
   `https://github.com/Visiolite-com/xp-master-ha` with type *Integration*.
2. Search for **Netroni XP-Master** in HACS, download it and restart Home Assistant.
3. Go to Settings → Devices & services. A Home Assistant running on the XP-Master finds it by
   itself. Elsewhere on the network: open **Remote Access** in the XP-Master's own Netroni panel,
   choose *Pair a Home Assistant*, then add *Netroni XP-Master* here and enter the code it shows
   (and the XP-Master's IP address if it isn't found by itself).

Without HACS: copy `custom_components/netroni` into your Home Assistant's
`config/custom_components/` folder and restart.

## Requirements

- A Netroni XP-Master with its current software.
- Home Assistant 2026.3 or newer.

## Support

Visiolite: [visiolite.com](https://visiolite.com). Release notes for the XP-Master software:
[visiolite.com/releases](https://visiolite.com/releases/).
