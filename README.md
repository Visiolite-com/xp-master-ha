# Netroni XP-Master for Home Assistant

Custom integration for the Visiolite Netroni XP-Master. It connects to the Netroni service
running on the Master ([Visiolite-com/xp-master](https://github.com/Visiolite-com/xp-master))
over its local WebSocket API and pushes updates instantly (`local_push`).

## What it creates

| Device | Entities |
| --- | --- |
| XP-Master | Parent device |
| XP-Mini (one per unit on the Visio-Link segment) | Lights created from the XP-Mini's **fixture profile**; a **Fixture profile** sensor; **Identify port 1–8** buttons |

| Profile | Lights |
| --- | --- |
| 8 Port | Port 1–8, dimmable |
| 4+4 Port TW | Ports 1+2 … 7+8, tunable white (2700–6500 K) |
| 8 Port TW | All ports (master brightness + shared colour temperature) and Port 1–8, dimmable |
| Custom 16 | Port 1A … 8B, dimmable |

Change a profile under Settings → Devices & services → Netroni XP-Master → **Configure**: pick the
XP-Mini, pick the profile, confirm. The XP-Mini's lights are replaced and their names and areas are
lost. Scripts can use the `netroni.set_profile` action. Names and areas you give lights are stored on
the Master too, so a fresh Home Assistant rebuilds from it.

## Install

- **HACS:** add this repository as a custom repository (type *Integration*), install, restart.
- **Manual:** copy `custom_components/netroni` into your Home Assistant `config/custom_components/`, restart.

The Master is discovered automatically (mDNS `_netroni._tcp`). Otherwise add
*Netroni XP-Master* under Settings → Devices & services and enter its IP address (port 8765).

## Status

Development skeleton against API v1 of the Netroni service. No authentication yet: LAN only.
The API client is bundled in `client.py`; it moves to a PyPI library before any core submission.
