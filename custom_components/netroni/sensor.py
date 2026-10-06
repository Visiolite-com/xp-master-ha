"""Read-only fixture profile per XP-Mini (change it through Configure or netroni.set_profile)."""
from __future__ import annotations

from homeassistant.components.sensor import SensorEntity
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import NetroniConfigEntry
from .entity import NetroniEntity
from .hub import NetroniHub


async def async_setup_entry(
    hass: HomeAssistant,
    entry: NetroniConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    hub = entry.runtime_data
    async_add_entities(ProfileSensor(hub, mini["uid"]) for mini in hub.config.get("minis", []))


class ProfileSensor(NetroniEntity, SensorEntity):
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_translation_key = "profile"

    def __init__(self, hub: NetroniHub, mini_uid: str) -> None:
        super().__init__(hub, mini_uid, f"{mini_uid}/profile")

    @property
    def native_value(self) -> str | None:
        mini = self.hub.mini(self.mini_uid)
        return self.hub.profile_name(mini["profile"]) if mini else None

    @property
    def extra_state_attributes(self) -> dict:
        mini = self.hub.mini(self.mini_uid) or {}
        return {"profile_id": mini.get("profile"), "dmx_start": mini.get("dmx_start")}
