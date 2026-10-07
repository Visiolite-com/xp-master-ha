"""Commissioning: an identify button per XP-Mini channel pair (ChnA and ChnB flash)."""
from __future__ import annotations

from homeassistant.components.button import ButtonDeviceClass, ButtonEntity
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import NetroniConfigEntry
from .client import NetroniError
from .const import CHANNEL_PAIRS
from .entity import NetroniEntity
from .hub import NetroniHub


async def async_setup_entry(
    hass: HomeAssistant,
    entry: NetroniConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    hub = entry.runtime_data
    async_add_entities(
        IdentifyChannelButton(hub, mini["uid"], channel)
        for mini in hub.config.get("minis", [])
        for channel in range(1, CHANNEL_PAIRS + 1)
    )


class IdentifyChannelButton(NetroniEntity, ButtonEntity):
    _attr_device_class = ButtonDeviceClass.IDENTIFY
    _attr_entity_category = EntityCategory.CONFIG
    _attr_translation_key = "identify_channel"

    def __init__(self, hub: NetroniHub, mini_uid: str, channel: int) -> None:
        super().__init__(hub, mini_uid, f"{mini_uid}/{channel}/identify")
        self.channel = channel
        self._attr_translation_placeholders = {"channel": str(channel)}

    async def async_press(self) -> None:
        try:
            await self.hub.client.call("mini/identify", uid=self.mini_uid, channel=self.channel)
        except NetroniError as err:
            raise HomeAssistantError(f"XP-Master rejected identify: {err}") from err
