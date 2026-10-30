<img src="https://raw.githubusercontent.com/Visiolite-com/xp-master-ha/main/custom_components/netroni/brand/logo.png" alt="Netroni" height="48">

# Visiolite Netroni XP-Master for Home Assistant

Control your Visiolite Netroni lighting from Home Assistant. Every light connected to your
XP-Minis shows up in Home Assistant, ready to name, put in a room, dim and use in automations.
Everything works on your own network, without a cloud service.

## What it does

- **Your lights in Home Assistant.** Each output of an XP-Mini is a dimmable light. A tunable-white
  strip (warm and cool white on one port) becomes a single light with a colour temperature.
- **Groups.** Dim several lights together, also across XP-Minis.
- **The Netroni panel.** A page in the Home Assistant sidebar to set up your installation:
  - see every XP-Mini and its lights, and give them names and rooms;
  - find a light quickly: when a fixture identifies itself, its port lights up in the panel;
  - make groups, and watch the DMX output live;
  - connect your lights to Apple Home, Google Home, Amazon Alexa or SmartThings through Matter;
  - let a Home Assistant elsewhere on your network control this XP-Master.
- **Replacing an XP-Mini.** A new XP-Mini can take over everything from the one it replaces:
  lights, names, rooms and groups. Your automations keep working.
- **Updates and backups.** New software for the XP-Master and the XP-Minis appears under
  Settings → Updates. The XP-Master's settings are included in your Home Assistant backups.

## Install

1. In HACS, open the menu (⋮) → *Custom repositories*, add
   `https://github.com/Visiolite-com/xp-master-ha` and choose the type *Integration*.
2. Search HACS for **Visiolite Netroni XP-Master**, download it and restart Home Assistant.
3. Go to Settings → Devices & services:
   - **Home Assistant on the XP-Master itself:** the XP-Master is found automatically. Confirm it.
   - **Home Assistant on another computer:** in the XP-Master's own Home Assistant, open the
     Netroni panel → *Remote Access* → *Pair a Home Assistant*. Then, in this Home Assistant, add
     the **Netroni XP-Master** integration and type the six-digit code it shows. If the XP-Master
     isn't found, enter its IP address too.

Without HACS, copy the `custom_components/netroni` folder into the `config/custom_components/`
folder of your Home Assistant and restart it.

## Requirements

- A Visiolite Netroni XP-Master, kept up to date (Settings → Updates).
- Home Assistant 2026.3 or newer.

## Support

Visit [visiolite.com](https://visiolite.com). What's new in each release:
[visiolite.com/releases](https://visiolite.com/releases/).
