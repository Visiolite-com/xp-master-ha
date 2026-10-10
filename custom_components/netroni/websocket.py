"""WebSocket commands behind the Netroni sidebar panel.

Everyone can look and use Identify; changing the installation (names, tunable-white ports,
removing an XP-Mini, pairing Matter apps) needs an administrator.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.config_entries import ConfigEntryState
from homeassistant.const import CONF_HOST
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.event import async_call_later

from .client import CommandError, NetroniError
from .const import DOMAIN, PORTS_PER_MINI, SIGNAL_HUBS_CHANGED
from .hub import ALL_MINIS, NetroniHub
from .matter import async_open_window, format_manual_code, qr_placeholders

UPDATE_DELAY = 0.3  # s: coalesce bursts (a pairing change touches many entities) into one update


@callback
def async_setup_websocket(hass: HomeAssistant) -> None:
    for command in (
        ws_subscribe,
        ws_identify,
        ws_set_pairs,
        ws_update_light,
        ws_remove_mini,
        ws_matter_status,
        ws_matter_open_window,
        ws_matter_close_window,
    ):
        websocket_api.async_register_command(hass, command)


def _hubs(hass: HomeAssistant) -> list[NetroniHub]:
    return [
        entry.runtime_data
        for entry in hass.config_entries.async_entries(DOMAIN)
        if entry.state is ConfigEntryState.LOADED
    ]


def _hub(hass: HomeAssistant, entry_id: str) -> NetroniHub:
    entry = hass.config_entries.async_get_entry(entry_id)
    if entry is None or entry.domain != DOMAIN or entry.state is not ConfigEntryState.LOADED:
        raise NetroniError("this XP-Master is not connected")
    return entry.runtime_data


def _overview(hass: HomeAssistant) -> dict:
    """Everything the panel shows except live light states (it reads those from hass.states)."""
    ent_reg, dev_reg, area_reg = er.async_get(hass), dr.async_get(hass), ar.async_get(hass)

    def area_name(area_id: str | None) -> str | None:
        area = area_reg.async_get_area(area_id) if area_id else None
        return area.name if area else None

    masters = []
    for hub in _hubs(hass):
        minis = []
        for mini in hub.config.get("minis", []):
            device = dev_reg.async_get_device(identifiers={(DOMAIN, mini["uid"])})
            minis.append(
                {
                    "uid": mini["uid"],
                    "name": device.name_by_user or device.name if device else mini["name"],
                    "online": mini.get("online", True),
                    "dmx_start": mini["dmx_start"],
                    "firmware": mini.get("firmware"),
                    "pairs": mini.get("pairs", []),
                    "device_id": device.id if device else None,
                    "area": area_name(device.area_id) if device else None,
                }
            )
        lights = []
        for light in hub.config.get("lights", []):
            entity_id = ent_reg.async_get_entity_id("light", DOMAIN, f"{hub.master_id}_{light['id']}")
            entry = ent_reg.async_get(entity_id) if entity_id else None
            device = dev_reg.async_get(entry.device_id) if entry and entry.device_id else None
            area_id = (entry.area_id if entry else None) or (device.area_id if device else None)
            lights.append(
                {
                    "id": light["id"],
                    "mini_uid": light["mini_uid"],
                    "key": light["key"],
                    "kind": light["kind"],
                    "default_name": light["default_name"],
                    "entity_id": entity_id,
                    "name": entry.name if entry else None,  # None: not named yet
                    "area_id": area_id,
                    "area": area_name(area_id),
                }
            )
        masters.append(
            {
                "entry_id": hub.entry.entry_id,
                "name": hub.master.get("name", "XP-Master"),
                "master_id": hub.master_id,
                "host": hub.entry.data[CONF_HOST],
                "connected": hub.available,
                "config_version": hub.config.get("version"),
                "device_id": hub.master_device_id,
                "ports_per_mini": PORTS_PER_MINI,
                "minis": minis,
                "lights": lights,
            }
        )
    return {"masters": masters}


@websocket_api.websocket_command({vol.Required("type"): "netroni/subscribe"})
@callback
def ws_subscribe(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Send the overview now and whenever it changes; forward port identifications."""
    msg_id = msg["id"]
    last: dict | None = None
    pending: Callable[[], None] | None = None
    hub_unsubs: list[Callable[[], None]] = []

    @callback
    def send_overview(_now=None) -> None:
        nonlocal last, pending
        pending = None
        data = _overview(hass)
        if data != last:
            last = data
            connection.send_message(websocket_api.event_message(msg_id, {"kind": "overview", "data": data}))

    @callback
    def schedule(*_args: Any) -> None:
        nonlocal pending
        if pending is None:
            pending = async_call_later(hass, UPDATE_DELAY, send_overview)

    @callback
    def watch_hubs() -> None:
        for unsub in hub_unsubs:
            unsub()
        hub_unsubs.clear()
        for hub in _hubs(hass):
            hub_unsubs.append(hub.async_add_listener(schedule))

            @callback
            def identified(data: dict, hub: NetroniHub = hub) -> None:
                connection.send_message(
                    websocket_api.event_message(
                        msg_id, {"kind": "identified", "entry_id": hub.entry.entry_id, **data}
                    )
                )

            hub_unsubs.append(hub.async_add_identify_listener(ALL_MINIS, identified))
        schedule()

    unsubs = [
        async_dispatcher_connect(hass, SIGNAL_HUBS_CHANGED, watch_hubs),
        hass.bus.async_listen(er.EVENT_ENTITY_REGISTRY_UPDATED, schedule),
        hass.bus.async_listen(dr.EVENT_DEVICE_REGISTRY_UPDATED, schedule),
        hass.bus.async_listen(ar.EVENT_AREA_REGISTRY_UPDATED, schedule),
    ]

    @callback
    def unsubscribe() -> None:
        for unsub in unsubs + hub_unsubs:
            unsub()
        if pending is not None:
            pending()

    connection.subscriptions[msg_id] = unsubscribe
    connection.send_result(msg_id)
    watch_hubs()
    send_overview()


def _error(connection: websocket_api.ActiveConnection, msg_id: int, err: NetroniError) -> None:
    code = err.code if isinstance(err, CommandError) else "netroni_error"
    message = str(err).split(": ", 1)[-1] if isinstance(err, CommandError) else str(err)
    connection.send_error(msg_id, code, message)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "netroni/identify",
        vol.Required("entry_id"): str,
        vol.Required("uid"): str,
        vol.Required("port"): vol.All(int, vol.Range(min=1, max=PORTS_PER_MINI)),
    }
)
@websocket_api.async_response
async def ws_identify(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    try:
        await _hub(hass, msg["entry_id"]).client.call("mini/identify", uid=msg["uid"], port=msg["port"])
    except NetroniError as err:
        _error(connection, msg["id"], err)
        return
    connection.send_result(msg["id"])


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "netroni/set_pairs",
        vol.Required("entry_id"): str,
        vol.Required("uid"): str,
        vol.Required("pairs"): [vol.All(int, vol.Range(min=1, max=PORTS_PER_MINI))],
    }
)
@websocket_api.async_response
async def ws_set_pairs(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    try:
        await _hub(hass, msg["entry_id"]).client.call(
            "mini/set_pairs", uid=msg["uid"], pairs=sorted(set(msg["pairs"]))
        )
    except NetroniError as err:
        _error(connection, msg["id"], err)
        return
    connection.send_result(msg["id"])


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "netroni/update_light",
        vol.Required("entity_id"): str,
        vol.Required("name"): vol.Any(str, None),
        vol.Required("area_id"): vol.Any(str, None),
    }
)
@callback
def ws_update_light(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Name a light and put it in an area (pushed on to the XP-Master by the label sync)."""
    ent_reg = er.async_get(hass)
    entry = ent_reg.async_get(msg["entity_id"])
    if entry is None or entry.platform != DOMAIN:
        connection.send_error(msg["id"], "not_found", "not a Netroni light")
        return
    if msg["area_id"] and ar.async_get(hass).async_get_area(msg["area_id"]) is None:
        connection.send_error(msg["id"], "not_found", "unknown area")
        return
    ent_reg.async_update_entity(
        entry.entity_id, name=(msg["name"] or "").strip() or None, area_id=msg["area_id"] or None
    )
    connection.send_result(msg["id"])


@websocket_api.require_admin
@websocket_api.websocket_command(
    {vol.Required("type"): "netroni/remove_mini", vol.Required("entry_id"): str, vol.Required("uid"): str}
)
@websocket_api.async_response
async def ws_remove_mini(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    try:
        await _hub(hass, msg["entry_id"]).client.call("mini/remove", uid=msg["uid"])
    except NetroniError as err:
        _error(connection, msg["id"], err)
        return
    connection.send_result(msg["id"])


async def _with_qr(hass: HomeAssistant, status: dict) -> dict:
    """Add the QR image and setup code while a pairing window is open."""
    if status.get("connected") and status.get("window_open"):
        status = {**status, **await hass.async_add_executor_job(qr_placeholders, status)}
    status.pop("qr_code", None)  # the panel shows the image
    status["manual_code"] = format_manual_code(status["manual_code"]) if "manual_code" in status else None
    return status


@websocket_api.websocket_command({vol.Required("type"): "netroni/matter_status", vol.Required("entry_id"): str})
@websocket_api.async_response
async def ws_matter_status(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    try:
        status = await _hub(hass, msg["entry_id"]).client.call("matter/status")
    except NetroniError as err:
        _error(connection, msg["id"], err)
        return
    if not connection.user.is_admin:  # pairing codes are for administrators only
        status = {k: v for k, v in status.items() if k not in ("qr_code", "manual_code")}
        connection.send_result(msg["id"], status)
        return
    connection.send_result(msg["id"], await _with_qr(hass, status))


@websocket_api.require_admin
@websocket_api.websocket_command(
    {vol.Required("type"): "netroni/matter_open_window", vol.Required("entry_id"): str}
)
@websocket_api.async_response
async def ws_matter_open_window(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    try:
        status = await async_open_window(_hub(hass, msg["entry_id"]))
    except NetroniError as err:
        _error(connection, msg["id"], err)
        return
    connection.send_result(msg["id"], await _with_qr(hass, status))


@websocket_api.require_admin
@websocket_api.websocket_command(
    {vol.Required("type"): "netroni/matter_close_window", vol.Required("entry_id"): str}
)
@websocket_api.async_response
async def ws_matter_close_window(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Cancel pairing: the bridge stops accepting the QR/setup code now."""
    try:
        await _hub(hass, msg["entry_id"]).client.call("matter/close_window")
    except NetroniError as err:
        _error(connection, msg["id"], err)
        return
    connection.send_result(msg["id"])
