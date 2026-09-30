"""Base entity: one device per XP-Mini, linked to the XP-Master device."""
from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity import Entity

from .const import DOMAIN, MANUFACTURER
from .hub import NetroniHub


class NetroniEntity(Entity):
    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, hub: NetroniHub, mini_uid: str, key: str) -> None:
        self.hub = hub
        self.mini_uid = mini_uid
        self._attr_unique_id = f"{hub.master_id}_{key}"
        mini = hub.mini(mini_uid) or {}
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, mini_uid)},
            manufacturer=MANUFACTURER,
            model="XP-Mini",
            name=mini.get("name") or f"XP-Mini {mini_uid}",
            serial_number=mini_uid,
            via_device_id=hub.master_device_id,
        )

    @property
    def available(self) -> bool:
        return self.hub.available

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self.hub.async_add_listener(self.async_write_ha_state))
