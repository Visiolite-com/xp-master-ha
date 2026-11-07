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
from homeassistant.helpers.dispatcher import async_dispatcher_connect, async_dispatcher_send
from homeassistant.helpers.event import async_call_later

from .client import CommandError, NetroniError
from .const import CONF_TOKEN, DOMAIN, PORTS_PER_MINI, SIGNAL_HUBS_CHANGED
from .hub import ALL_MINIS, NetroniHub
from .sync import async_apply_group_area
from .matter import async_open_window, format_manual_code, qr_placeholders
from .firmware import mini_update_available

UPDATE_DELAY = 0.3  # s: coalesce bursts (a pairing change touches many entities) into one update


@callback
def async_setup_websocket(hass: HomeAssistant) -> None:
    for command in (
        ws_subscribe,
        ws_identify,
        ws_set_pairs,
        ws_set_cct_range,
        ws_group_save,
        ws_group_delete,
        ws_update_light,
        ws_remove_mini,
        ws_restart_mini,
        ws_set_dmx,
        ws_suggest_dmx,
        ws_factory_reset_mini,
        ws_replace_mini,
        ws_dmx_snapshot,
        ws_matter_status,
        ws_matter_open_window,
        ws_matter_close_window,
        ws_remote_status,
        ws_remote_open_pairing,
        ws_remote_close_pairing,
        ws_remote_revoke,
        ws_scene_capture,
        ws_scene_save,
        ws_set_transitions,
        ws_scene_delete,
        ws_pack_set_input,
        ws_set_curve,
        ws_artnet_status,
        ws_artnet_set,
        ws_sacn_status,
        ws_sacn_set,
        ws_relay_status,
        ws_relay_set,
        ws_update_channel,
        ws_mqtt_status,
        ws_mqtt_set,
    ):
        websocket_api.async_register_command(hass, command)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "netroni/scene_capture",
        vol.Required("entry_id"): str,
        vol.Optional("scene_id"): str,  # absent: a new scene
        vol.Required("name"): vol.All(str, vol.Length(min=1, max=64)),
        vol.Required("members"): [str],  # light and group ids: as they are now
        # start and end: seconds, decimals allowed; absent or None: at once
        vol.Optional("transition"): vol.Any(None, vol.All(vol.Coerce(float), vol.Range(min=0, max=600))),
        vol.Optional("transition_end"): vol.Any(None, vol.All(vol.Coerce(float), vol.Range(min=0, max=600))),
    }
)
@websocket_api.async_response
async def ws_scene_capture(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """A scene of these lights and groups as they are now (Capture), new or over an existing one."""
    hub = _hub(hass, msg["entry_id"])
    fields = {k: msg[k] for k in ("name", "members", "transition", "transition_end", "scene_id") if k in msg}
    try:
        result = await hub.client.call("scene/capture", **fields)
    except NetroniError as err:
        _error(connection, msg["id"], err)
        return
    connection.send_result(msg["id"], result)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "netroni/set_transitions",
        vol.Required("entry_id"): str,
        vol.Required("uid"): str,
        vol.Required("port"): vol.All(int, vol.Range(min=1, max=8)),
        vol.Optional("up"): vol.All(vol.Coerce(float), vol.Range(min=0, max=600)),  # seconds, decimals allowed
        vol.Optional("down"): vol.All(vol.Coerce(float), vol.Range(min=0, max=600)),
    }
)
@websocket_api.async_response
async def ws_set_transitions(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """A port's default transitions: used when a command (a light, a group, a scene) gives none."""
    hub = _hub(hass, msg["entry_id"])
    fields = {k: msg[k] for k in ("up", "down") if k in msg}
    try:
        await hub.client.call("mini/set_transitions", uid=msg["uid"], port=msg["port"], **fields)
    except NetroniError as err:
        _error(connection, msg["id"], err)
        return
    connection.send_result(msg["id"], None)


_ENTRY = vol.Schema(
    {
        vol.Exclusive("light", "member"): str,
        vol.Exclusive("group", "member"): str,
        vol.Optional("on", default=True): bool,
        vol.Optional("brightness", default=255): vol.All(int, vol.Range(min=1, max=255)),
        vol.Optional("kelvin"): vol.All(int, vol.Range(min=1000, max=10000)),
    }
)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "netroni/scene_save",
        vol.Required("entry_id"): str,
        vol.Optional("scene_id"): str,  # absent: a new scene
        vol.Required("name"): vol.All(str, vol.Length(min=1, max=64)),
        # start and end: seconds, decimals allowed; absent or None: at once
        vol.Optional("transition"): vol.Any(None, vol.All(vol.Coerce(float), vol.Range(min=0, max=600))),
        vol.Optional("transition_end"): vol.Any(None, vol.All(vol.Coerce(float), vol.Range(min=0, max=600))),
        vol.Required("entries"): [_ENTRY],  # each a light or a group, with what it is set to
    }
)
@websocket_api.async_response
async def ws_scene_save(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Create a scene from its entries, or change one (name, transitions, entries)."""
    hub = _hub(hass, msg["entry_id"])
    fields = {k: msg[k] for k in ("name", "transition", "transition_end", "entries") if k in msg}
    try:
        if "scene_id" in msg:
            await hub.client.call("scene/update", scene_id=msg["scene_id"], **fields)
            result = {"scene_id": msg["scene_id"]}
        else:
            result = await hub.client.call("scene/create", **fields)
    except NetroniError as err:
        _error(connection, msg["id"], err)
        return
    connection.send_result(msg["id"], result)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {vol.Required("type"): "netroni/scene_delete", vol.Required("entry_id"): str, vol.Required("scene_id"): str}
)
@websocket_api.async_response
async def ws_scene_delete(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    hub = _hub(hass, msg["entry_id"])
    try:
        await hub.client.call("scene/delete", scene_id=msg["scene_id"])
    except NetroniError as err:
        _error(connection, msg["id"], err)
        return
    connection.send_result(msg["id"], None)


_ACTION = vol.Schema(
    {
        vol.Required("kind"): vol.In(
            ["none", "scene", "scene_toggle", "scene_off", "group_on", "group_off", "group_toggle",
             "port_on", "port_off", "port_toggle"]
        ),
        vol.Optional("scene_id"): str,
        vol.Optional("group_id"): str,
        vol.Optional("light_id"): vol.Any(None, str),
        vol.Optional("brightness"): vol.Any(None, vol.All(int, vol.Range(min=1, max=255))),
        vol.Optional("transition"): vol.Any(None, vol.All(vol.Coerce(float), vol.Range(min=0, max=25.4))),
    }
)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "netroni/pack_set_input",
        vol.Required("entry_id"): str,
        vol.Required("uid"): str,
        vol.Required("input"): int,
        vol.Optional("mode"): vol.In(["push", "toggle"]),
        vol.Optional("name"): vol.All(str, vol.Length(max=32)),
        vol.Optional("action"): _ACTION,
        vol.Optional("action_off"): _ACTION,
    }
)
@websocket_api.async_response
async def ws_pack_set_input(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """What an X-Pack's input does: kept on the X-Pack itself, so it works with no XP-Master."""
    hub = _hub(hass, msg["entry_id"])
    fields = {k: msg[k] for k in ("mode", "name", "action", "action_off") if k in msg}
    try:
        await hub.client.call("pack/set_input", uid=msg["uid"], input=msg["input"], **fields)
    except NetroniError as err:
        _error(connection, msg["id"], err)
        return
    connection.send_result(msg["id"], None)


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
        devices = {
            ident[1]: device
            for device in dr.async_entries_for_config_entry(dev_reg, hub.entry.entry_id)
            for ident in device.identifiers
            if ident[0] == DOMAIN
        }
        for mini in hub.config.get("minis", []):
            device = devices.get(mini["uid"])
            minis.append(
                {
                    "uid": mini["uid"],
                    "name": device.name_by_user or device.name if device else mini["name"],
                    "online": mini.get("online", True),
                    "dmx_start": mini["dmx_start"],
                    "dmx_resolution": mini.get("dmx_resolution", 8),
                    "dimming_curve": mini.get("dimming_curve"),
                    # what its description says it takes; empty: not known (an older XP-Master)
                    "settings_offered": mini.get("settings_offered") or {},
                    # default transitions per port, ms: {"3": [up, down]}; ports not listed: 0
                    "transitions": mini.get("transitions") or {},
                    "firmware": mini.get("firmware"),
                    # its firmware update (the Firmware update entity has the details)
                    "update_available": mini_update_available(hub, mini),
                    "update_state": (hub.mini_updates.get(mini["uid"]) or {}).get("state"),
                    "update_progress": (hub.mini_updates.get(mini["uid"]) or {}).get("progress"),
                    "firmware_entity": ent_reg.async_get_entity_id("update", DOMAIN, f"{hub.entity_prefix}_{mini['uid']}/firmware"),
                    "pairs": mini.get("pairs", []),
                    "hardware_uid": mini.get("hardware_uid") or mini["uid"],
                    "replace_candidate": bool(mini.get("replace_candidate")),
                    "device_id": device.id if device else None,
                    "area": area_name(device.area_id) if device else None,
                }
            )
        lights = []
        for light in hub.config.get("lights", []):
            entity_id = ent_reg.async_get_entity_id("light", DOMAIN, f"{hub.entity_prefix}_{light['id']}")
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
                    # None: not named yet. A name stored on the XP-Master (given in another
                    # Home Assistant before this one was added) counts as named.
                    "name": (entry.name if entry else None) or light.get("name") or None,
                    "area_id": area_id,
                    "area": area_name(area_id),
                    "min_kelvin": light.get("min_kelvin"),  # tunable white: the port's colour range
                    "max_kelvin": light.get("max_kelvin"),
                    "group": light.get("group"),
                }
            )
        groups = []
        for group in hub.config.get("groups", []):
            entity_id = ent_reg.async_get_entity_id("light", DOMAIN, f"{hub.entity_prefix}_group/{group['id']}")
            entry = ent_reg.async_get(entity_id) if entity_id else None
            groups.append(
                {
                    "id": group["id"],
                    "name": group["name"],
                    "members": group.get("members", []),
                    "entity_id": entity_id,
                    "area_id": entry.area_id if entry else None,
                    "hide_members": group.get("hide_members", True),
                    "area": area_name(entry.area_id) if entry else group.get("area"),
                }
            )
        scenes = [
            {
                "id": scene["id"],
                "name": scene["name"],
                # start and end, ms; None: at once
                "transition": scene.get("transition"),
                "transition_end": scene.get("transition_end"),
                "entries": [{k: v for k, v in e.items() if v is not None} for e in scene.get("entries", [])],
                "entity_id": ent_reg.async_get_entity_id("scene", DOMAIN, f"{hub.entity_prefix}_scene/{scene['id']}"),
            }
            for scene in hub.config.get("scenes", [])
        ]
        master_device = dev_reg.async_get(hub.master_device_id) if hub.master_device_id else None
        masters.append(
            {
                "entry_id": hub.entry.entry_id,
                # Its name in Home Assistant (renamed on its device page), as for the XP-Minis.
                "name": master_device.name_by_user or master_device.name
                if master_device else hub.master.get("name", "XP-Master"),
                "master_id": hub.master_id,
                "host": hub.entry.data[CONF_HOST],
                "connected": hub.available,
                "config_version": hub.config.get("version"),
                # XP-Master release and updates (the Firmware update entity has the details)
                "product": hub.product,
                "release": hub.update_status.get("installed"),
                "update_available": (hub.update_status.get("latest") or {}).get("release")
                if hub.update_status.get("update_available") else None,
                "update_state": hub.update_status.get("state"),
                # its release channel ("stable", "beta"); None: it has no updates
                "update_channel": hub.update_status.get("channel") if hub.update_status else None,
                "firmware_entity": ent_reg.async_get_entity_id("update", DOMAIN, f"{hub.master_id}_firmware"),
                # Paired over remote access (this Home Assistant is not the XP-Master's own).
                "remote": bool(hub.entry.data.get(CONF_TOKEN)),
                "device_id": hub.master_device_id,
                "area": area_name(master_device.area_id) if master_device else None,
                "ports_per_mini": PORTS_PER_MINI,
                "minis": minis,
                "lights": lights,
                "groups": groups,
                "scenes": scenes,
                # an XP-Master or XP-Bridge from before scenes has none in its configuration
                "scenes_supported": "scenes" in hub.config,
                "packs": [
                    {
                        **pack,
                        "inputs": [
                            {**i, "entity_id": ent_reg.async_get_entity_id(
                                "event", DOMAIN, f"{hub.entity_prefix}_{pack['uid']}/input{i['input']}")}
                            for i in pack.get("inputs", [])
                        ],
                    }
                    for pack in hub.config.get("packs", [])
                ],
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
        vol.Required("type"): "netroni/group_save",
        vol.Required("entry_id"): str,
        vol.Optional("group_id"): str,  # absent: a new group
        vol.Required("name"): vol.All(str, vol.Length(min=1, max=64)),
        vol.Required("members"): [str],
        vol.Optional("area_id"): vol.Any(str, None),  # None: no area
        vol.Optional("hide_members", default=True): bool,
    }
)
@websocket_api.async_response
async def ws_group_save(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Create a group, or change its name and members (a light in another group moves here)."""
    hub = _hub(hass, msg["entry_id"])
    area = ar.async_get(hass).async_get_area(msg["area_id"]) if msg.get("area_id") else None
    area_name = area.name if area else None
    try:
        if "group_id" in msg:
            await hub.client.call(
                "group/update", group_id=msg["group_id"], name=msg["name"], members=msg["members"], area=area_name,
                hide_members=msg["hide_members"],
            )
            result = {"group_id": msg["group_id"]}
        else:
            result = await hub.client.call(
                "group/create", name=msg["name"], members=msg["members"], area=area_name, hide_members=msg["hide_members"]
            )
    except NetroniError as err:
        _error(connection, msg["id"], err)
        return
    # The entity of an existing group moves now; a new one gets the area when it appears.
    entity_id = er.async_get(hass).async_get_entity_id("light", DOMAIN, f"{hub.entity_prefix}_group/{result['group_id']}")
    if entity_id:
        async_apply_group_area(hass, entity_id, area_name)
    connection.send_result(msg["id"], result)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {vol.Required("type"): "netroni/group_delete", vol.Required("entry_id"): str, vol.Required("group_id"): str}
)
@websocket_api.async_response
async def ws_group_delete(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    try:
        await _hub(hass, msg["entry_id"]).client.call("group/delete", group_id=msg["group_id"])
    except NetroniError as err:
        _error(connection, msg["id"], err)
        return
    connection.send_result(msg["id"])


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "netroni/set_cct_range",
        vol.Required("entry_id"): str,
        vol.Required("uid"): str,
        vol.Required("port"): vol.All(int, vol.Range(min=1, max=PORTS_PER_MINI)),
        vol.Required("warm"): vol.All(int, vol.Range(min=1000, max=10000)),
        vol.Required("cool"): vol.All(int, vol.Range(min=1000, max=10000)),
    }
)
@websocket_api.async_response
async def ws_set_cct_range(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Colour range of a tunable-white port (the strip's warmest and coolest white)."""
    try:
        await _hub(hass, msg["entry_id"]).client.call(
            "mini/set_cct_range", uid=msg["uid"], port=msg["port"], warm=msg["warm"], cool=msg["cool"]
        )
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


async def _mini_command(connection: websocket_api.ActiveConnection, msg: dict, hub: NetroniHub, command: str, **args) -> None:
    try:
        result = await hub.client.call(command, **args)
    except NetroniError as err:
        _error(connection, msg["id"], err)
        return
    connection.send_result(msg["id"], result or {})


@websocket_api.require_admin
@websocket_api.websocket_command(
    {vol.Required("type"): "netroni/restart_mini", vol.Required("entry_id"): str, vol.Required("uid"): str}
)
@websocket_api.async_response
async def ws_restart_mini(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    await _mini_command(connection, msg, _hub(hass, msg["entry_id"]), "mini/restart", uid=msg["uid"])


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "netroni/set_dmx",
        vol.Required("entry_id"): str,
        vol.Required("uid"): str,
        vol.Optional("start"): vol.All(int, vol.Range(min=1, max=512)),
        vol.Optional("resolution"): vol.In([8, 16]),
    }
)
@websocket_api.async_response
async def ws_set_dmx(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Move an XP-Mini's DMX block and/or set it to 8 or 16-bit (checked by the XP-Master or XP-Bridge:
    the block must fit and overlap no other)."""
    args = {k: msg[k] for k in ("start", "resolution") if k in msg}
    await _mini_command(connection, msg, _hub(hass, msg["entry_id"]), "mini/set_dmx", uid=msg["uid"], **args)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "netroni/suggest_dmx",
        vol.Required("entry_id"): str,
        vol.Required("uid"): str,
        vol.Required("resolution"): vol.In([8, 16]),
    }
)
@websocket_api.async_response
async def ws_suggest_dmx(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Where an XP-Mini's block goes at a resolution: {start, resolution, slots, moves}."""
    await _mini_command(connection, msg, _hub(hass, msg["entry_id"]), "mini/suggest_dmx", uid=msg["uid"],
                        resolution=msg["resolution"])


@websocket_api.require_admin
@websocket_api.websocket_command(
    {vol.Required("type"): "netroni/factory_reset_mini", vol.Required("entry_id"): str, vol.Required("uid"): str}
)
@websocket_api.async_response
async def ws_factory_reset_mini(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    await _mini_command(connection, msg, _hub(hass, msg["entry_id"]), "mini/factory_reset", uid=msg["uid"])


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "netroni/replace_mini",
        vol.Required("entry_id"): str,
        vol.Required("old"): str,
        vol.Required("new"): str,
    }
)
@websocket_api.async_response
async def ws_replace_mini(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    await _mini_command(connection, msg, _hub(hass, msg["entry_id"]), "mini/replace", old=msg["old"], new=msg["new"])


@websocket_api.websocket_command({vol.Required("type"): "netroni/dmx_snapshot", vol.Required("entry_id"): str})
@websocket_api.async_response
async def ws_dmx_snapshot(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """The DMX monitor: what the XP-Master sends, for everyone to look at (read-only)."""
    try:
        snapshot = await _hub(hass, msg["entry_id"]).client.call("dmx/snapshot")
    except NetroniError as err:
        _error(connection, msg["id"], err)
        return
    connection.send_result(msg["id"], snapshot)


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


# --- the Settings tab: an XP-Mini's dimming curve, Art-Net, the release channel ---


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "netroni/set_curve",
        vol.Required("entry_id"): str,
        vol.Required("uid"): str,
        vol.Required("curve"): vol.All(int, vol.Range(min=1, max=14)),
    }
)
@websocket_api.async_response
async def ws_set_curve(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """An XP-Mini's dimming curve, one of those its firmware offers (settings_offered)."""
    try:
        await _hub(hass, msg["entry_id"]).client.call("mini/set_curve", uid=msg["uid"], curve=msg["curve"])
    except NetroniError as err:
        _error(connection, msg["id"], err)
        return
    connection.send_result(msg["id"], None)


@websocket_api.websocket_command({vol.Required("type"): "netroni/artnet_status", vol.Required("entry_id"): str})
@websocket_api.async_response
async def ws_artnet_status(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """The Art-Net settings and what the node receives."""
    try:
        status = await _hub(hass, msg["entry_id"]).client.call("artnet/get")
    except NetroniError as err:
        _error(connection, msg["id"], err)
        return
    connection.send_result(msg["id"], status)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "netroni/artnet_set",
        vol.Required("entry_id"): str,
        vol.Optional("enabled"): bool,
        vol.Optional("pro_mode"): bool,
        vol.Optional("port_address"): vol.All(int, vol.Range(min=0, max=32767)),
    }
)
@websocket_api.async_response
async def ws_artnet_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Art-Net on or off, Pro Mode, the universe: in use at once; the new status."""
    fields = {k: msg[k] for k in ("enabled", "pro_mode", "port_address") if k in msg}
    try:
        status = await _hub(hass, msg["entry_id"]).client.call("artnet/set", **fields)
    except NetroniError as err:
        _error(connection, msg["id"], err)
        return
    connection.send_result(msg["id"], status)


@websocket_api.websocket_command({vol.Required("type"): "netroni/sacn_status", vol.Required("entry_id"): str})
@websocket_api.async_response
async def ws_sacn_status(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """The sACN settings and what the receiver receives."""
    try:
        status = await _hub(hass, msg["entry_id"]).client.call("sacn/get")
    except NetroniError as err:
        _error(connection, msg["id"], err)
        return
    connection.send_result(msg["id"], status)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "netroni/sacn_set",
        vol.Required("entry_id"): str,
        vol.Optional("enabled"): bool,
        vol.Optional("universe"): vol.All(int, vol.Range(min=1, max=63999)),
    }
)
@websocket_api.async_response
async def ws_sacn_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """sACN on or off, the universe: in use at once; the new status (Pro Mode: netroni/artnet_set)."""
    fields = {k: msg[k] for k in ("enabled", "universe") if k in msg}
    try:
        status = await _hub(hass, msg["entry_id"]).client.call("sacn/set", **fields)
    except NetroniError as err:
        _error(connection, msg["id"], err)
        return
    connection.send_result(msg["id"], status)


@websocket_api.websocket_command({vol.Required("type"): "netroni/relay_status", vol.Required("entry_id"): str})
@websocket_api.async_response
async def ws_relay_status(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Access from outside the home: the setting and the connection to the Netroni relay."""
    try:
        status = await _hub(hass, msg["entry_id"]).client.call("relay/get")
    except NetroniError as err:
        _error(connection, msg["id"], err)
        return
    connection.send_result(msg["id"], status)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {vol.Required("type"): "netroni/relay_set", vol.Required("entry_id"): str, vol.Required("enabled"): bool}
)
@websocket_api.async_response
async def ws_relay_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Access from outside the home on or off: in use at once; the new status."""
    try:
        status = await _hub(hass, msg["entry_id"]).client.call("relay/set", enabled=msg["enabled"])
    except NetroniError as err:
        _error(connection, msg["id"], err)
        return
    connection.send_result(msg["id"], status)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "netroni/update_channel",
        vol.Required("entry_id"): str,
        vol.Required("channel"): vol.In(["stable", "beta"]),
    }
)
@websocket_api.async_response
async def ws_update_channel(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Stable or beta releases; a new channel is looked at at once."""
    hub = _hub(hass, msg["entry_id"])
    try:
        before = hub.update_status.get("channel")
        hub.update_status = await hub.client.call("update/set_channel", channel=msg["channel"])
        if msg["channel"] != before:
            hub.update_status = await hub.client.call("update/check")
    except NetroniError as err:
        _error(connection, msg["id"], err)
        return
    async_dispatcher_send(hass, SIGNAL_HUBS_CHANGED)  # the panel shows the channel
    connection.send_result(msg["id"], hub.update_status)


@websocket_api.websocket_command({vol.Required("type"): "netroni/mqtt_status", vol.Required("entry_id"): str})
@websocket_api.async_response
async def ws_mqtt_status(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """The MQTT settings (no password: only whether one is set) and the connection."""
    try:
        status = await _hub(hass, msg["entry_id"]).client.call("mqtt/get")
    except NetroniError as err:
        _error(connection, msg["id"], err)
        return
    connection.send_result(msg["id"], status)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "netroni/mqtt_set",
        vol.Required("entry_id"): str,
        vol.Optional("enabled"): bool,
        vol.Optional("server"): vol.All(str, vol.Length(max=200)),
        vol.Optional("client_id"): vol.All(str, vol.Length(max=200)),
        vol.Optional("prefix"): vol.All(str, vol.Length(max=200)),
        vol.Optional("username"): vol.All(str, vol.Length(max=200)),
        vol.Optional("password"): vol.All(str, vol.Length(max=200)),  # "": none
    }
)
@websocket_api.async_response
async def ws_mqtt_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """MQTT on or off and its connection: in use at once; the new status."""
    fields = {k: msg[k] for k in ("enabled", "server", "client_id", "prefix", "username", "password") if k in msg}
    try:
        status = await _hub(hass, msg["entry_id"]).client.call("mqtt/set", **fields)
    except NetroniError as err:
        _error(connection, msg["id"], err)
        return
    connection.send_result(msg["id"], status)


# --- remote access: Home Assistants elsewhere on the LAN, paired with this XP-Master ---


def _remote_view(status: dict, admin: bool) -> dict:
    if not admin and status.get("pairing"):  # the code is for administrators only
        status = {**status, "pairing": {"seconds_left": status["pairing"]["seconds_left"]}}
    return status


async def _remote_call(hass: HomeAssistant, connection, msg: dict, command: str, **fields) -> None:
    try:
        status = await _hub(hass, msg["entry_id"]).client.call(command, **fields)
    except NetroniError as err:
        _error(connection, msg["id"], err)
        return
    connection.send_result(msg["id"], _remote_view(status, connection.user.is_admin))


@websocket_api.websocket_command({vol.Required("type"): "netroni/remote_status", vol.Required("entry_id"): str})
@websocket_api.async_response
async def ws_remote_status(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    await _remote_call(hass, connection, msg, "remote/status")


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): "netroni/remote_open_pairing", vol.Required("entry_id"): str})
@websocket_api.async_response
async def ws_remote_open_pairing(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    await _remote_call(hass, connection, msg, "remote/open_pairing")


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): "netroni/remote_close_pairing", vol.Required("entry_id"): str})
@websocket_api.async_response
async def ws_remote_close_pairing(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    await _remote_call(hass, connection, msg, "remote/close_pairing")


@websocket_api.require_admin
@websocket_api.websocket_command(
    {vol.Required("type"): "netroni/remote_revoke", vol.Required("entry_id"): str, vol.Required("client_id"): str}
)
@websocket_api.async_response
async def ws_remote_revoke(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    await _remote_call(hass, connection, msg, "remote/revoke", client_id=msg["client_id"])
