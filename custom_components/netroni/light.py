"""Light entities: one per port output (Port nA/nB) or one per tunable-white port (Port nT)."""
from __future__ import annotations

from typing import Any

from homeassistant.components.light import (
    ATTR_BRIGHTNESS,
    ATTR_COLOR_TEMP_KELVIN,
    ColorMode,
    LightEntity,
)
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import NetroniConfigEntry
from .client import NetroniError
from .const import KELVIN_COOL, KELVIN_WARM
from .entity import NetroniEntity, async_track
from .hub import NetroniHub
from .sync import async_apply_group_area, async_push_label, async_restore_area, async_update_hidden


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
        lambda config: {
            **{l["id"]: (lambda l=l: NetroniLight(hub, l)) for l in config.get("lights", [])},
            **{f"group/{g['id']}": (lambda g=g: NetroniGroupLight(hub, g)) for g in config.get("groups", [])},
        },
    )


class NetroniGroupLight(LightEntity):
    """A group: on if any member is on; its brightness is the fader over the members' own levels."""

    # No device: a group can span XP-Minis, and as an entity of its own it has exactly the area
    # chosen for it (on the XP-Master device it would take that device's area).
    _attr_should_poll = False
    _attr_has_entity_name = False
    _attr_supported_color_modes = {ColorMode.BRIGHTNESS}
    _attr_color_mode = ColorMode.BRIGHTNESS
    _attr_icon = "mdi:lightbulb-group-outline"

    def __init__(self, hub: NetroniHub, group: dict) -> None:
        self.hub = hub
        self.group_id = group["id"]
        self._attr_unique_id = f"{hub.entity_prefix}_group/{group['id']}"

    @property
    def name(self) -> str:
        return (self.hub.group(self.group_id) or {}).get("name", self.group_id)

    @property
    def available(self) -> bool:
        return self.hub.available and self.group_id in self.hub.group_states

    @property
    def is_on(self) -> bool:
        return bool(self.hub.group_states.get(self.group_id, {}).get("on"))

    @property
    def brightness(self) -> int | None:
        return self.hub.group_states.get(self.group_id, {}).get("brightness")

    @property
    def extra_state_attributes(self) -> dict:
        group = self.hub.group(self.group_id) or {}
        return {"netroni_group_id": self.group_id, "members": group.get("members", [])}

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self.hub.async_add_listener(self.async_write_ha_state))
        ent_reg = er.async_get(self.hass)
        reg_entry = ent_reg.async_get(self.entity_id)
        if reg_entry and reg_entry.device_id:  # groups made before 0.16 sat on the XP-Master device
            ent_reg.async_update_entity(self.entity_id, device_id=None)
        group = self.hub.group(self.group_id) or {}
        if group.get("area"):  # a new or rebuilt Home Assistant picks up the group's area
            async_apply_group_area(self.hass, self.entity_id, group["area"])

    async def async_turn_on(self, **kwargs: Any) -> None:
        fields: dict[str, Any] = {"on": True}
        if ATTR_BRIGHTNESS in kwargs:
            fields["brightness"] = max(1, int(kwargs[ATTR_BRIGHTNESS]))
        await self._set(fields)

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self._set({"on": False})

    async def _set(self, fields: dict) -> None:
        try:
            await self.hub.client.call("group/set", group_id=self.group_id, **fields)
        except NetroniError as err:
            raise HomeAssistantError(str(err)) from err


class NetroniLight(NetroniEntity, LightEntity):
    def __init__(self, hub: NetroniHub, light: dict) -> None:
        super().__init__(hub, light["mini_uid"], light["id"])
        self.light_id = light["id"]
        # Master-stored name wins on first registration, so a fresh HA rebuilds from the Master.
        self._attr_name = light.get("name") or light["default_name"]
        if light["kind"] == "tunable_white":
            self._attr_supported_color_modes = {ColorMode.COLOR_TEMP}
            self._attr_color_mode = ColorMode.COLOR_TEMP
        else:
            self._attr_supported_color_modes = {ColorMode.BRIGHTNESS}
            self._attr_color_mode = ColorMode.BRIGHTNESS

    # The colour range is the port's own (set in the Netroni panel), so it is read live.
    @property
    def min_color_temp_kelvin(self) -> int:
        return (self.hub.light(self.light_id) or {}).get("min_kelvin", KELVIN_WARM)

    @property
    def max_color_temp_kelvin(self) -> int:
        return (self.hub.light(self.light_id) or {}).get("max_kelvin", KELVIN_COOL)

    @property
    def _state(self) -> dict:
        return self.hub.states.get(self.light_id, {})

    @property
    def available(self) -> bool:
        return super().available and self.light_id in self.hub.states

    @property
    def is_on(self) -> bool:
        return bool(self._state.get("on"))

    @property
    def brightness(self) -> int | None:
        return self._state.get("brightness")

    @property
    def color_temp_kelvin(self) -> int | None:
        if self.color_mode is ColorMode.COLOR_TEMP:
            return self._state.get("color_temp_kelvin")
        return None

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        light = self.hub.light(self.light_id) or {}
        # Master -> HA first (a fresh HA picks up the stored area), then HA -> Master
        # (a new light inheriting its XP-Mini's area gets that area recorded).
        async_restore_area(self.hass, self.entity_id, light.get("area"))
        async_update_hidden(self.hass, self.hub)  # a new light in a group that hides its lights
        self.hub.entry.async_create_background_task(
            self.hass, async_push_label(self.hass, self.hub, self.entity_id), "netroni push label"
        )

    async def async_turn_on(self, **kwargs: Any) -> None:
        fields: dict[str, Any] = {"on": True}
        if ATTR_BRIGHTNESS in kwargs:
            fields["brightness"] = max(1, kwargs[ATTR_BRIGHTNESS])
        if ATTR_COLOR_TEMP_KELVIN in kwargs:
            fields["color_temp_kelvin"] = kwargs[ATTR_COLOR_TEMP_KELVIN]
        await self._set(fields)

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self._set({"on": False})

    async def _set(self, fields: dict[str, Any]) -> None:
        try:
            await self.hub.client.call("light/set", light_id=self.light_id, **fields)
        except NetroniError as err:
            raise HomeAssistantError(f"XP-Master rejected the command: {err}") from err
