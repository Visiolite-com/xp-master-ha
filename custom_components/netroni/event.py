"""Event entities: per XP-Mini, a device on one of its ports identified itself; per X-Pack input, it
was pressed (a push button) or turned on or off (a switch).

Gives an Activity (logbook) entry and device-page history for every signal, and a trigger
for automations. An X-Pack's own action (its scene or group) has gone out already, also with
Home Assistant down: the event is for the record and for anything more.
"""
from __future__ import annotations

from homeassistant.components.event import EventEntity
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import NetroniConfigEntry
from .const import DOMAIN, MANUFACTURER
from .entity import NetroniEntity, async_track
from .hub import NetroniHub, pack_name
from .identify import port_label

EVENT_PORT_IDENTIFIED = "port_identified"


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
        lambda config: {m["uid"]: (lambda uid=m["uid"]: PortIdentifiedEvent(hub, uid)) for m in config.get("minis", [])},
    )
    async_track(
        entry,
        hub,
        async_add_entities,
        lambda config: {
            f"{p['uid']}/input{i['input']}": (lambda uid=p["uid"], n=i["input"]: InputEvent(hub, uid, n))
            for p in config.get("packs", []) for i in p.get("inputs", [])
        },
    )


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
            if (entity_id := ent_reg.async_get_entity_id("light", DOMAIN, f"{self.hub.entity_prefix}_{light_id}"))
        ]
        self._trigger_event(
            EVENT_PORT_IDENTIFIED,
            {"port": port_label(data), "side": data.get("side"), "lights": entity_ids},
        )
        self.async_write_ha_state()


class InputEvent(EventEntity):
    """An X-Pack input: a push button or a wall switch. The X-Pack is its device."""

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_translation_key = "input"
    _attr_event_types = ["pressed", "turned_on", "turned_off"]

    def __init__(self, hub: NetroniHub, pack_uid: str, number: int) -> None:
        self.hub = hub
        self.pack_uid = pack_uid
        self.number = number
        self._attr_unique_id = f"{hub.entity_prefix}_{pack_uid}/input{number}"
        self._attr_translation_placeholders = {"input": str(number)}
        pack = hub.pack(pack_uid) or {}
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, pack_uid)},
            manufacturer=MANUFACTURER,
            model="X-Pack-RS",
            name=pack_name(pack or {"uid": pack_uid}),
            serial_number=pack.get("hardware_uid") or pack_uid,  # the unit now (hub._update_devices)
            sw_version=pack.get("firmware"),
            via_device_id=hub.master_device_id,
        )

    def _input(self) -> dict:
        pack = self.hub.pack(self.pack_uid) or {}
        return next((i for i in pack.get("inputs", []) if i["input"] == self.number), {})

    @property
    def name(self) -> str | None:
        return self._input().get("name") or f"Input {self.number}"

    @property
    def available(self) -> bool:
        # Always available while connected: its state is the time of the last press.
        return self.hub.available

    @property
    def extra_state_attributes(self) -> dict:
        given = self._input()
        return {"mode": given.get("mode"), "action": given.get("action"), "action_off": given.get("action_off")}

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self.hub.async_add_listener(self.async_write_ha_state))
        self.async_on_remove(self.hub.async_add_input_listener(self.pack_uid, self.number, self._handle))

    @callback
    def _handle(self, event: str) -> None:
        if event in self._attr_event_types:
            self._trigger_event(event)
            self.async_write_ha_state()
