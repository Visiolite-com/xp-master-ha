"""Replacing an XP-Mini: shared by the Repairs prompt and Configure."""
from __future__ import annotations

from .hub import NetroniHub


def replace_summary(hub: NetroniHub, old: dict, new: dict) -> dict[str, str]:
    """Placeholders for the confirmation: what the new unit takes over, and what is dropped."""
    lights = [l for l in hub.config.get("lights", []) if l["mini_uid"] == new["uid"]]
    renamed = [l for l in lights if l.get("name") or l.get("area")]
    lost = (
        f"\n\nThe names and areas given to {new['name']}'s own lights ({len(renamed)}) are dropped."
        if renamed
        else ""
    )
    return {
        "old": old["name"],
        "old_uid": old["uid"],
        "new": new["name"],
        "new_uid": new.get("hardware_uid") or new["uid"],
        "dmx": str(old["dmx_start"]),
        "lost": lost,
    }


async def async_replace(hub: NetroniHub, old_uid: str, new_uid: str) -> dict:
    return await hub.client.call("mini/replace", old=old_uid, new=new_uid)
