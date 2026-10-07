# Netroni XP-Master for Home Assistant

Custom integration for the Visiolite Netroni XP-Master. It connects to the Netroni service
running on the Master ([Visiolite-com/xp-master](https://github.com/Visiolite-com/xp-master))
over its local WebSocket API and pushes updates instantly (`local_push`).

## What it creates

| Device | Entities |
| --- | --- |
| XP-Master | Parent device |
| XP-Mini (one per unit on the Visio-Link segment) | A **Master** light, the channel lights below, and **Identify Ch1–Ch8** buttons |

| Light | Kind | Behaviour |
| --- | --- | --- |
| Master | Dimmable | On/off switches every light of the XP-Mini; its brightness scales every light's output |
| Ch1A … Ch8B | Dimmable | One per channel (default) |
| Chn TW | Tunable white, 2700–6500 K | Replaces ChnA (warm) and ChnB (cool) when the channel is paired |

Lights report their real output, so dimming the Master light visibly dims every light.

Pair or unpair channels under Settings → Devices & services → Netroni XP-Master → **gear icon**:
pick the XP-Mini, tick the channels that should be tunable white, confirm. Only the lights of the
channels you change are replaced (and lose their names and areas). Scripts can use the
`netroni.pair_channel` and `netroni.unpair_channel` actions. Names and areas you give lights are
stored on the Master too, so a fresh Home Assistant rebuilds from it.

## Install

- **HACS:** add this repository as a custom repository (type *Integration*), install, restart.
- **Manual:** copy `custom_components/netroni` into your Home Assistant `config/custom_components/`, restart.

The Master is discovered automatically (mDNS `_netroni._tcp`). Otherwise add
*Netroni XP-Master* under Settings → Devices & services and enter its IP address (port 8765).

## Status

Development skeleton against API v2 of the Netroni service. No authentication yet: LAN only.
The API client is bundled in `client.py`; it moves to a PyPI library before any core submission.
