# Netroni XP-Master for Home Assistant

Custom integration for the Visiolite Netroni XP-Master. It connects to the Netroni service
running on the Master ([Visiolite-com/xp-master](https://github.com/Visiolite-com/xp-master))
over its local WebSocket API and pushes updates instantly (`local_push`).

## What it creates

| Device | Entities |
| --- | --- |
| XP-Master | Parent device |
| XP-Mini (one per unit on the Visio-Link segment) | One **light** per configured port (dimmable or tunable white 2700–6500 K); per port a **Port N mode** select and an **Identify port N** button (configuration entities) |

Commissioning inside Home Assistant: open an XP-Mini device, press *Identify port N* to find the
fixture, set *Port N mode*, and the light entities appear. Rename lights and assign areas as usual;
names and areas are stored on the Master too, so a fresh Home Assistant rebuilds from it.

## Install

- **HACS:** add this repository as a custom repository (type *Integration*), install, restart.
- **Manual:** copy `custom_components/netroni` into your Home Assistant `config/custom_components/`, restart.

The Master is discovered automatically (mDNS `_netroni._tcp`). Otherwise add
*Netroni XP-Master* under Settings → Devices & services and enter its IP address (port 8765).

## Status

Development skeleton against API v0 of the Netroni service. No authentication yet: LAN only.
The API client is bundled in `client.py`; it moves to a PyPI library before any core submission.
