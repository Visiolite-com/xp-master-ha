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


def for_board(release: dict, device: dict) -> bool:
    """The release has firmware for the device's board (its "board", visiolink docs/hardware.md). Not
    known yet (not read, or an older XP-Master or XP-Bridge that doesn't report it): offered, and an
    install without an image for it fails safely."""
    board, boards = device.get("board"), release.get("hardware")
    return board is None or boards is None or board in boards


def mini_release(hub: NetroniHub) -> dict:
    """The XP-Mini firmware release the XP-Master fetched (update/status, xp_mini), or {}."""
    return ((hub.update_status.get("xp_mini") or {}).get("latest")) or {}


PACK_OVER_DATA2 = (0, 2, 0)  # the first X-Pack firmware that takes an update over Data 2
PACK_NOTE = "The X-Pack will restart at the end: its buttons won't respond for about two seconds."


def pack_release(hub: NetroniHub) -> dict:
    """The X-Pack firmware release the XP-Master fetched (update/status, x_pack), or {}."""
    return ((hub.update_status.get("x_pack") or {}).get("latest")) or {}


def mini_update_available(hub: NetroniHub, mini: dict) -> str | None:
    """The newer XP-Mini firmware this XP-Mini can take over Data 2, or None (the entity and the panel)."""
    release = mini_release(hub).get("release")
    firmware = mini.get("firmware")
    if release and for_board(mini_release(hub), mini) and _version(release) > _version(firmware) and _version(firmware) >= MINI_OVER_DATA2:
        return release
    return None
