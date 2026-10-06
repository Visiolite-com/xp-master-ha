"""Light entities: one per light produced by a configured port."""
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
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import NetroniConfigEntry
from .client import NetroniError
from .const import KELVIN_COOL, KELVIN_WARM
from .entity import NetroniEntity
from .hub import NetroniHub
from .sync import async_push_label, async_restore_area


async def async_setup_entry(
    hass: HomeAssistant,
    entry: NetroniConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    hub = entry.runtime_data
    async_add_entities(NetroniLight(hub, light) for light in hub.config.get("lights", []))


class NetroniLight(NetroniEntity, LightEntity):
    def __init__(self, hub: NetroniHub, light: dict) -> None:
        super().__init__(hub, light["mini_uid"], light["id"])
        self.light_id = light["id"]
        # Master-stored name wins on first registration, so a fresh HA rebuilds from the Master.
        self._attr_name = light.get("name") or light["default_name"]
        if light["kind"] == "tunable_white":
            self._attr_supported_color_modes = {ColorMode.COLOR_TEMP}
            self._attr_color_mode = ColorMode.COLOR_TEMP
            self._attr_min_color_temp_kelvin = KELVIN_WARM
            self._attr_max_color_temp_kelvin = KELVIN_COOL
        else:
            self._attr_supported_color_modes = {ColorMode.BRIGHTNESS}
            self._attr_color_mode = ColorMode.BRIGHTNESS

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
