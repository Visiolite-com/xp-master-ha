"""Event entity per XP-Mini: fires when a device on one of its ports identifies itself.

Gives an Activity (logbook) entry and device-page history for every signal, and a trigger
for automations.
"""
from __future__ import annotations

from homeassistant.components.event import EventEntity
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import NetroniConfigEntry
from .const import DOMAIN
from .entity import NetroniEntity
from .hub import NetroniHub
from .identify import port_label

EVENT_PORT_IDENTIFIED = "port_identified"


async def async_setup_entry(
    hass: HomeAssistant,
    entry: NetroniConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    hub = entry.runtime_data
    async_add_entities(PortIdentifiedEvent(hub, mini["uid"]) for mini in hub.config.get("minis", []))


class PortIdentifiedEvent(NetroniEntity, EventEntity):
    _attr_translation_key = "port_identified"
    _attr_event_types = [EVENT_PORT_IDENTIFIED]

    def __init__(self, hub: NetroniHub, mini_uid: str) -> None:
        super().__init__(hub, mini_uid, f"{mini_uid}/port_identified")

    @property
    def available(self) -> bool:
        # Always available: its state is the time of the last signal, so an availability
        # round-trip would otherwise log a false "Port identified".
        return True

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(self.hub.async_add_identify_listener(self.mini_uid, self._handle))

    @callback
    def _handle(self, data: dict) -> None:
        ent_reg = er.async_get(self.hass)
        entity_ids = [
            entity_id
            for light_id in data.get("light_ids", [])
            if (entity_id := ent_reg.async_get_entity_id("light", DOMAIN, f"{self.hub.master_id}_{light_id}"))
        ]
        self._trigger_event(
            EVENT_PORT_IDENTIFIED,
            {"port": port_label(data), "side": data.get("side"), "lights": entity_ids},
        )
        self.async_write_ha_state()
