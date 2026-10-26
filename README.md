# Netroni XP-Master for Home Assistant

Custom integration for the Visiolite Netroni XP-Master. It connects to the Netroni service
running on the Master ([Visiolite-com/xp-master](https://github.com/Visiolite-com/xp-master))
over its local WebSocket API and pushes updates instantly (`local_push`).

## What it creates

| Device | Entities |
| --- | --- |
| XP-Master | Parent device |
| XP-Mini (one per unit on the Visio-Link segment) | The port lights below, **Identify Port 1–8** buttons and a **Restart** button. *Delete* on its device page forgets an XP-Mini that was disconnected; **Configure → Factory reset an XP-Mini** wipes a connected one (it comes back as a new XP-Mini). |

| Light | Kind | Behaviour |
| --- | --- | --- |
| Port 1A … Port 8B | Dimmable | One per output (default) |
| Port nT | Tunable white, 2200–5000 K | Replaces Port nA and nB when the port is tunable white; warm = A 100 % / B 0 %, cool = the reverse |

Choose tunable-white ports under Settings → Devices & services → Netroni XP-Master → **gear icon**:
pick the XP-Mini, tick the ports that should be tunable white, confirm. Only the lights of the
ports you change are replaced (and lose their names and areas). Scripts can use the
`netroni.pair_port` and `netroni.unpair_port` actions. Names and areas you give lights are
stored on the Master too, so a fresh Home Assistant rebuilds from it.

## Install

- **HACS:** add this repository as a custom repository (type *Integration*), install, restart.
- **Manual:** copy `custom_components/netroni` into your Home Assistant `config/custom_components/`, restart.

The Master is discovered automatically (mDNS `_netroni._tcp`). Otherwise add
*Netroni XP-Master* under Settings → Devices & services and enter its IP address (port 8765).

## Status

Development skeleton against API v3 of the Netroni service. No authentication yet: LAN only.
The API client is bundled in `client.py`; it moves to a PyPI library before any core submission.
