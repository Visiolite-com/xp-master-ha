"""Commissioning: an identify button per XP-Mini port (Port nA and nB flash), and a restart button
per XP-Mini (it keeps its settings). Factory reset is not a button (see config_flow.py): automations,
scenes and voice assistants can press buttons."""
from __future__ import annotations

from homeassistant.components.button import ButtonDeviceClass, ButtonEntity
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import NetroniConfigEntry
from .client import CommandError, NetroniError
from .const import PORTS_PER_MINI
from .entity import NetroniEntity, async_track
from .hub import NetroniHub


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
            **{
                f"{m['uid']}/{port}": (lambda uid=m["uid"], port=port: IdentifyPortButton(hub, uid, port))
                for m in config.get("minis", [])
                for port in range(1, PORTS_PER_MINI + 1)
            },
            **{
                f"{m['uid']}/restart": (lambda uid=m["uid"]: RestartMiniButton(hub, uid))
                for m in config.get("minis", [])
            },
        },
    )


class IdentifyPortButton(NetroniEntity, ButtonEntity):
    _attr_device_class = ButtonDeviceClass.IDENTIFY
    _attr_entity_category = EntityCategory.CONFIG
    _attr_translation_key = "identify_port"

    def __init__(self, hub: NetroniHub, mini_uid: str, port: int) -> None:
        super().__init__(hub, mini_uid, f"{mini_uid}/{port}/identify")
        self.port = port
        self._attr_translation_placeholders = {"port": str(port)}

    @property
    def available(self) -> bool:
        # Always available: a button's state is its last-press time, so going unavailable and
        # back would log a false "Pressed" whenever the XP-Mini drops out. A press on an
        # offline XP-Mini is refused with a clear message instead.
        return True

    async def async_press(self) -> None:
        try:
            await self.hub.client.call("mini/identify", uid=self.mini_uid, port=self.port)
        except CommandError as err:
            if err.code == "offline":
                raise HomeAssistantError(f"Cannot identify: {str(err).split(': ', 1)[-1]}") from err
            raise HomeAssistantError(f"XP-Master rejected identify: {err}") from err
        except NetroniError as err:
            raise HomeAssistantError(f"Cannot reach the XP-Master: {err}") from err


class RestartMiniButton(NetroniEntity, ButtonEntity):
    _attr_device_class = ButtonDeviceClass.RESTART
    _attr_entity_category = EntityCategory.CONFIG
    _attr_translation_key = "restart"

    def __init__(self, hub: NetroniHub, mini_uid: str) -> None:
        super().__init__(hub, mini_uid, f"{mini_uid}/restart")

    @property
    def available(self) -> bool:
        return True  # as IdentifyPortButton: refused with a message while the XP-Mini is offline

    async def async_press(self) -> None:
        try:
            await self.hub.client.call("mini/restart", uid=self.mini_uid)
        except CommandError as err:
            if err.code == "offline":
                raise HomeAssistantError(f"Cannot restart: {str(err).split(': ', 1)[-1]}") from err
            raise HomeAssistantError(f"XP-Master rejected the restart: {err}") from err
        except NetroniError as err:
            raise HomeAssistantError(f"Cannot reach the XP-Master: {err}") from err
