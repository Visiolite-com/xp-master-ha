"""XP-Mini firmware updates: when one applies (the update entities and the panel).

Its own module: websocket.py uses it too, and is imported by __init__ before the platforms.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .hub import NetroniHub

MINI_OVER_DATA2 = (0, 13, 0)  # the first XP-Mini firmware that takes an update over Data 2
MINI_NOTE = "The XP-Mini restarts at the end: its lights go off for about a second."


def _version(text: str | None) -> tuple[int, ...]:
    try:
        return tuple(int(part) for part in (text or "").split("-")[0].split("."))
    except ValueError:
        return ()


def mini_release(hub: NetroniHub) -> dict:
    """The XP-Mini firmware release the XP-Master fetched (update/status, xp_mini), or {}."""
    return ((hub.update_status.get("xp_mini") or {}).get("latest")) or {}


def mini_update_available(hub: NetroniHub, mini: dict) -> str | None:
    """The newer XP-Mini firmware this XP-Mini can take over Data 2, or None (the entity and the panel)."""
    release = mini_release(hub).get("release")
    firmware = mini.get("firmware")
    if release and _version(release) > _version(firmware) and _version(firmware) >= MINI_OVER_DATA2:
        return release
    return None
