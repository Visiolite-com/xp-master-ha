"""Keep names and areas on the Master, so a fresh Home Assistant can rebuild from it and every
Home Assistant the XP-Master is in shows the same names.

HA -> Master: when a user renames a light or moves it (or its XP-Mini) to another area,
push the name and area name with light/update; renaming the XP-Master or an XP-Mini device
pushes master/update or mini/update.
Master -> HA: when a light entity first appears with no area, apply the area stored on the Master;
a name changed on the Master (from another Home Assistant) replaces the name given here.
"""
from __future__ import annotations

import logging
from collections.abc import Callable

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er

from .client import NetroniError
from .const import DOMAIN
from .hub import NetroniHub
from .identify import async_dismiss_for_entity

_LOGGER = logging.getLogger(__name__)


@callback
def async_restore_area(hass: HomeAssistant, entity_id: str, area_name: str | None) -> None:
    if not area_name:
        return
    ent_reg = er.async_get(hass)
    entry = ent_reg.async_get(entity_id)
    if entry is None or entry.area_id:
        return
    device = dr.async_get(hass).async_get(entry.device_id) if entry.device_id else None
    if device and device.area_id:
        return
    area = ar.async_get(hass).async_get_or_create(area_name)
    ent_reg.async_update_entity(entity_id, area_id=area.id)


@callback
def async_update_hidden(hass: HomeAssistant, hub: NetroniHub) -> None:
    """Hide the lights of groups set to "hide its lights", show them again otherwise.

    Hidden on the integration's behalf, so only those are ever shown again: a light the user
    hid by hand stays hidden."""
    ent_reg = er.async_get(hass)
    hidden = {
        member
        for group in hub.config.get("groups", [])
        if group.get("hide_members", True)
        for member in group.get("members", [])
    }
    prefix = f"{hub.master_id}_"
    for light in hub.config.get("lights", []):
        entity_id = ent_reg.async_get_entity_id("light", DOMAIN, prefix + light["id"])
        entry = ent_reg.async_get(entity_id) if entity_id else None
        if entry is None:
            continue
        if light["id"] in hidden and entry.hidden_by is None:
            ent_reg.async_update_entity(entity_id, hidden_by=er.RegistryEntryHider.INTEGRATION)
        elif light["id"] not in hidden and entry.hidden_by is er.RegistryEntryHider.INTEGRATION:
            ent_reg.async_update_entity(entity_id, hidden_by=None)


@callback
def async_apply_group_area(hass: HomeAssistant, entity_id: str, area_name: str | None) -> None:
    """Give a group's entity the area stored with the group (None: no area)."""
    ent_reg = er.async_get(hass)
    entry = ent_reg.async_get(entity_id)
    if entry is None:
        return
    area_id = ar.async_get(hass).async_get_or_create(area_name).id if area_name else None
    if entry.area_id != area_id:
        ent_reg.async_update_entity(entity_id, area_id=area_id)


async def async_push_group_area(hass: HomeAssistant, hub: NetroniHub, entity_id: str) -> None:
    """The user moved a group's entity to another area in Home Assistant: store it on the XP-Master."""
    reg_entry = er.async_get(hass).async_get(entity_id)
    prefix = f"{hub.master_id}_group/"
    if reg_entry is None or not reg_entry.unique_id.startswith(prefix):
        return
    group_id = reg_entry.unique_id.removeprefix(prefix)
    group = hub.group(group_id)
    area = ar.async_get(hass).async_get_area(reg_entry.area_id) if reg_entry.area_id else None
    area_name = area.name if area else None
    if group is None or group.get("area") == area_name:
        return
    try:
        await hub.client.call("group/update", group_id=group_id, area=area_name)
    except NetroniError as err:
        _LOGGER.warning("could not store the area of %s on the XP-Master: %s", entity_id, err)


async def async_push_label(hass: HomeAssistant, hub: NetroniHub, entity_id: str) -> None:
    """Store a light's HA name and area on the Master if they differ from what it has."""
    reg_entry = er.async_get(hass).async_get(entity_id)
    prefix = f"{hub.master_id}_"
    if reg_entry is None or not reg_entry.unique_id.startswith(prefix):
        return
    light_id = reg_entry.unique_id.removeprefix(prefix)
    light = hub.light(light_id)
    if light is None:
        return
    area_id = reg_entry.area_id
    if area_id is None and reg_entry.device_id:
        device = dr.async_get(hass).async_get(reg_entry.device_id)
        area_id = device.area_id if device else None
    area = ar.async_get(hass).async_get_area(area_id) if area_id else None
    # Only a name the user set counts; clearing it in HA keeps the Master's name.
    name = reg_entry.name or light.get("name", "")
    area_name = area.name if area else None
    if (name, area_name) == (light.get("name", ""), light.get("area")):
        return
    try:
        await hub.client.call("light/update", light_id=light_id, name=name, area=area_name)
    except NetroniError as err:
        _LOGGER.warning("could not store name/area of %s on the XP-Master: %s", entity_id, err)


@callback
def async_apply_renames(hass: HomeAssistant, hub: NetroniHub, old: dict, new: dict) -> None:
    """Names the Master changed between two configurations replace the names given here.

    Only changes count: a name this Home Assistant pushed comes back equal to its own, and one
    given here that the Master doesn't have yet (being pushed) is left alone."""
    if not old:
        return
    dev_reg, ent_reg = dr.async_get(hass), er.async_get(hass)

    def rename_device(identifier: str, name: str) -> None:
        device = hub.device(identifier)
        if device is None:
            return
        by_user = None if device.name_by_user and device.name_by_user != name else device.name_by_user
        if (device.name, device.name_by_user) != (name, by_user):
            dev_reg.async_update_device(device.id, name=name, name_by_user=by_user)

    old_master = (old.get("master") or {}).get("name")
    new_master = (new.get("master") or {}).get("name")
    if new_master and new_master != old_master:
        rename_device(hub.master_id, new_master)
    old_minis = {m["uid"]: m.get("name") for m in old.get("minis", [])}
    for mini in new.get("minis", []):
        if mini.get("name") and mini["uid"] in old_minis and mini["name"] != old_minis[mini["uid"]]:
            rename_device(mini["uid"], mini["name"])
    old_lights = {l["id"]: l.get("name") or "" for l in old.get("lights", [])}
    for light in new.get("lights", []):
        name = light.get("name") or ""
        if not name or light["id"] not in old_lights or name == old_lights[light["id"]]:
            continue
        entity_id = ent_reg.async_get_entity_id("light", DOMAIN, f"{hub.master_id}_{light['id']}")
        entry = ent_reg.async_get(entity_id) if entity_id else None
        if entry is not None and entry.name != name:
            ent_reg.async_update_entity(entity_id, name=name)


async def async_push_device_name(hass: HomeAssistant, hub: NetroniHub, device_id: str) -> None:
    """The user renamed the XP-Master or an XP-Mini in Home Assistant: store it on the XP-Master."""
    device = dr.async_get(hass).async_get(device_id)
    ident = next((i[1] for i in device.identifiers if i[0] == DOMAIN), None) if device else None
    name = device.name_by_user if device else None
    if not ident or not name:  # cleared: the XP-Master keeps its name
        return
    try:
        if ident == hub.master_id:
            if name != hub.config.get("master", {}).get("name"):
                await hub.client.call("master/update", name=name)
        elif (mini := hub.mini(ident)) is not None and name != mini.get("name"):
            await hub.client.call("mini/update", uid=ident, name=name)
    except NetroniError as err:
        _LOGGER.warning("could not store the name of %s on the XP-Master: %s", name, err)


@callback
def async_setup_label_sync(
    hass: HomeAssistant, entry: ConfigEntry, hub: NetroniHub
) -> Callable[[], None]:
    ent_reg = er.async_get(hass)
    dev_reg = dr.async_get(hass)

    def push(entity_id: str):
        return async_push_label(hass, hub, entity_id)

    def light_entities(device_id: str | None = None) -> list[str]:
        return [
            e.entity_id
            for e in er.async_entries_for_config_entry(ent_reg, entry.entry_id)
            if e.domain == "light" and (device_id is None or e.device_id == device_id)
        ]

    @callback
    def on_entity_update(event: Event[er.EventEntityRegistryUpdatedData]) -> None:
        data = event.data
        if data["action"] != "update" or not ({"name", "area_id"} & set(data["changes"])):
            return
        reg_entry = ent_reg.async_get(data["entity_id"])
        if reg_entry and reg_entry.unique_id.startswith(f"{hub.master_id}_group/"):
            if "area_id" in data["changes"]:
                entry.async_create_background_task(
                    hass, async_push_group_area(hass, hub, data["entity_id"]), "netroni push group area"
                )
            return
        if data["entity_id"] in light_entities():
            entry.async_create_background_task(hass, push(data["entity_id"]), "netroni push label")
            if "name" in data["changes"]:
                async_dismiss_for_entity(hass, hub, data["entity_id"])

    @callback
    def on_device_update(event: Event[dr.EventDeviceRegistryUpdatedData]) -> None:
        data = event.data
        changes = data.get("changes", {}) if data["action"] == "update" else {}
        if not ({"area_id", "name_by_user"} & set(changes)):
            return
        device = dev_reg.async_get(data["device_id"])
        if device is None or not any(i[0] == DOMAIN for i in device.identifiers):
            return
        if device not in dr.async_entries_for_config_entry(dev_reg, entry.entry_id):
            return  # another XP-Master's
        if "name_by_user" in changes:
            entry.async_create_background_task(
                hass, async_push_device_name(hass, hub, data["device_id"]), "netroni push device name"
            )
        if "area_id" not in changes:
            return
        for entity_id in light_entities(data["device_id"]):
            entry.async_create_background_task(hass, push(entity_id), "netroni push label")

    unsub_entity = hass.bus.async_listen(er.EVENT_ENTITY_REGISTRY_UPDATED, on_entity_update)
    unsub_device = hass.bus.async_listen(dr.EVENT_DEVICE_REGISTRY_UPDATED, on_device_update)

    def unsubscribe() -> None:
        unsub_entity()
        unsub_device()

    return unsubscribe
