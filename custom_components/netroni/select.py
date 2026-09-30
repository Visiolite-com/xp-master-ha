"""Commissioning: a mode selector per XP-Mini port."""
from __future__ import annotations

from homeassistant.components.select import SelectEntity
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import NetroniConfigEntry
from .client import NetroniError
from .const import PORT_MODES, PORTS_PER_MINI
from .entity import NetroniEntity
from .hub import NetroniHub


async def async_setup_entry(
    hass: HomeAssistant,
    entry: NetroniConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    hub = entry.runtime_data
    async_add_entities(
        PortModeSelect(hub, mini["uid"], port)
        for mini in hub.config.get("minis", [])
        for port in range(1, PORTS_PER_MINI + 1)
    )


class PortModeSelect(NetroniEntity, SelectEntity):
    _attr_entity_category = EntityCategory.CONFIG
    _attr_translation_key = "port_mode"
    _attr_options = PORT_MODES

    def __init__(self, hub: NetroniHub, mini_uid: str, port: int) -> None:
        super().__init__(hub, mini_uid, f"{mini_uid}/{port}/mode")
        self.port = port
        self._attr_translation_placeholders = {"port": str(port)}

    @property
    def current_option(self) -> str | None:
        mini = self.hub.mini(self.mini_uid)
        return mini["ports"].get(str(self.port)) if mini else None

    async def async_select_option(self, option: str) -> None:
        try:
            await self.hub.client.call(
                "port/configure", uid=self.mini_uid, port=self.port, mode=option
            )
        except NetroniError as err:
            raise HomeAssistantError(f"XP-Master rejected the change: {err}") from err
