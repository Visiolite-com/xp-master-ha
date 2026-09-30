"""Keep light names and areas on the Master, so a fresh Home Assistant can rebuild from it.

HA -> Master: when a user renames a light or moves it (or its XP-Mini) to another area,
push the name and area name with light/update.
Master -> HA: when a light entity first appears with no area, apply the area stored on the Master.
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
        if data["entity_id"] in light_entities():
            entry.async_create_background_task(hass, push(data["entity_id"]), "netroni push label")

    @callback
    def on_device_update(event: Event[dr.EventDeviceRegistryUpdatedData]) -> None:
        data = event.data
        if data["action"] != "update" or "area_id" not in data.get("changes", {}):
            return
        device = dev_reg.async_get(data["device_id"])
        if device is None or not any(i[0] == DOMAIN for i in device.identifiers):
            return
        for entity_id in light_entities(data["device_id"]):
            entry.async_create_background_task(hass, push(entity_id), "netroni push label")

    unsub_entity = hass.bus.async_listen(er.EVENT_ENTITY_REGISTRY_UPDATED, on_entity_update)
    unsub_device = hass.bus.async_listen(dr.EVENT_DEVICE_REGISTRY_UPDATED, on_device_update)

    def unsubscribe() -> None:
        unsub_entity()
        unsub_device()

    return unsubscribe
