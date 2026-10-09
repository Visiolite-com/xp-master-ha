"""Connection sensor per XP-Mini: shows on its device page whether it answers on the Visio-Link."""
from __future__ import annotations

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import NetroniConfigEntry
from .entity import NetroniEntity, async_track
from .hub import NetroniHub


async def async_setup_entry(
    hass: HomeAssistant,
    entry: NetroniConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    hub = entry.runtime_data
    async_track(
        entry,
        hub,
        async_add_entities,
        lambda config: {m["uid"]: (lambda uid=m["uid"]: MiniConnection(hub, uid)) for m in config.get("minis", [])},
    )


class MiniConnection(NetroniEntity, BinarySensorEntity):
    _attr_device_class = BinarySensorDeviceClass.CONNECTIVITY
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_translation_key = "connection"

    def __init__(self, hub: NetroniHub, mini_uid: str) -> None:
        super().__init__(hub, mini_uid, f"{mini_uid}/connection")

    @property
    def available(self) -> bool:
        # Reports "Disconnected" for an offline XP-Mini; only unknown when the XP-Master itself
        # is unreachable.
        return self.hub.available

    @property
    def is_on(self) -> bool:
        return self.hub.mini_online(self.mini_uid)
