"""Matter page of the options dialog: the pairing QR code and the apps already paired.

The XP-Master's Matter bridge reports its pairing status to the Netroni service, which hands it to
us with "matter/status"; Home Assistant itself is not part of the Matter connection.
"""
from __future__ import annotations

import asyncio

import segno

from .client import NetroniError
from .hub import NetroniHub


async def async_open_window(hub: NetroniHub) -> dict:
    """Open a 3-minute pairing window (paired or not) and return the status once it is open.

    The QR/setup code is only shown, and accepted, while such a window is open.
    """
    status = await hub.client.call("matter/status")
    if not status.get("connected"):
        raise NetroniError("the Matter bridge of the XP-Master is not running")
    if status.get("window_open"):
        return status
    await hub.client.call("matter/open_window")
    for _ in range(10):  # the bridge reports the open window within a moment
        await asyncio.sleep(0.5)
        status = await hub.client.call("matter/status")
        if status.get("window_open"):
            return status
    raise NetroniError("the pairing window did not open")


def paired_apps_text(status: dict) -> str:
    apps = [fabric.get("label") or fabric.get("vendor") for fabric in status.get("fabrics", [])]
    return "\n".join(f"- {app}" for app in apps) or "- (none)"


def qr_placeholders(status: dict) -> dict[str, str]:
    """QR image (PNG data URI) and setup code; builds the image, so run it in the executor."""
    qr = segno.make_qr(status["qr_code"], error="m")
    return {
        "qr": qr.png_data_uri(scale=6, border=4, dark="#000000", light="#ffffff"),
        "code": format_manual_code(status["manual_code"]),
        "window": "The code works for 3 minutes; open this page again if it runs out.",
    }


def format_manual_code(code: str) -> str:
    """11-digit Matter setup code as printed on devices: 1234-567-8901."""
    digits = code.replace("-", "")
    return f"{digits[:4]}-{digits[4:7]}-{digits[7:]}" if len(digits) == 11 else code
