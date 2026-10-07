"""Commissioning: an identify button per XP-Mini port (Port nA and nB flash)."""
from __future__ import annotations

from homeassistant.components.button import ButtonDeviceClass, ButtonEntity
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import NetroniConfigEntry
from .client import NetroniError
from .const import PORTS_PER_MINI
from .entity import NetroniEntity
from .hub import NetroniHub


async def async_setup_entry(
    hass: HomeAssistant,
    entry: NetroniConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    hub = entry.runtime_data
    async_add_entities(
        IdentifyPortButton(hub, mini["uid"], port)
        for mini in hub.config.get("minis", [])
        for port in range(1, PORTS_PER_MINI + 1)
    )


class IdentifyPortButton(NetroniEntity, ButtonEntity):
    _attr_device_class = ButtonDeviceClass.IDENTIFY
    _attr_entity_category = EntityCategory.CONFIG
    _attr_translation_key = "identify_port"

    def __init__(self, hub: NetroniHub, mini_uid: str, port: int) -> None:
        super().__init__(hub, mini_uid, f"{mini_uid}/{port}/identify")
        self.port = port
        self._attr_translation_placeholders = {"port": str(port)}

    async def async_press(self) -> None:
        try:
            await self.hub.client.call("mini/identify", uid=self.mini_uid, port=self.port)
        except NetroniError as err:
            raise HomeAssistantError(f"XP-Master rejected identify: {err}") from err
