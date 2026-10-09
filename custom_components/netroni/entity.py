"""Base entity: one device per XP-Mini, linked to the XP-Master device."""
from __future__ import annotations

from collections.abc import Callable

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity import Entity
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

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
            sw_version=mini.get("firmware"),
            via_device_id=hub.master_device_id,
        )

    @property
    def available(self) -> bool:
        """Unavailable while the Master is unreachable or this XP-Mini is offline."""
        return self.hub.available and self.hub.mini_online(self.mini_uid)

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self.hub.async_add_listener(self.async_write_ha_state))


@callback
def async_track(
    entry: ConfigEntry,
    hub: NetroniHub,
    async_add_entities: AddConfigEntryEntitiesCallback,
    build: Callable[[dict], dict[str, Callable[[], Entity]]],
) -> None:
    """Add a platform's entities now, and those of new lights / XP-Minis as they appear.

    build(config) returns {key: factory} for every entity the configuration should have; only
    keys not added before are created. Removed ones are deleted by the hub (async_remove_stale).
    """
    added: set[str] = set()

    @callback
    def sync() -> None:
        wanted = build(hub.config)
        added.intersection_update(wanted)  # forget removed ones, so they can come back
        new = [factory() for key, factory in wanted.items() if key not in added]
        added.update(wanted)
        if new:
            async_add_entities(new)

    sync()
    entry.async_on_unload(hub.async_add_structure_listener(sync))
