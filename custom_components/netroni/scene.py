"""Scene entities: one per scene of the XP-Master or XP-Bridge (visiolink docs/ids.md). Activating one
recalls it on every XP-Mini at once (one broadcast); its lights follow as their XP-Minis report them.
A scene has no state of its own: Home Assistant shows when it was last activated, also when that was
somewhere else (the app, an X-Pack's button), so automations on it run then too."""
from __future__ import annotations

import time
from typing import Any

from homeassistant.components.scene import Scene
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import NetroniConfigEntry
from .client import NetroniError, user_message
from .entity import async_track
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
        lambda config: {f"scene/{s['id']}": (lambda s=s: NetroniScene(hub, s)) for s in config.get("scenes", [])},
    )


class NetroniScene(Scene):
    """A scene of the installation. No device: it can span XP-Minis, as a group can."""

    _attr_should_poll = False
    _attr_has_entity_name = False
    _attr_icon = "mdi:palette-outline"

    def __init__(self, hub: NetroniHub, scene: dict) -> None:
        self.hub = hub
        self.scene_id = scene["id"]
        self._attr_unique_id = f"{hub.entity_prefix}_scene/{scene['id']}"
        self._own_until = 0.0  # a recall started here: its report from the XP-Master is not a second one

    @property
    def name(self) -> str:
        scene = next((s for s in self.hub.config.get("scenes", []) if s["id"] == self.scene_id), None)
        return (scene or {}).get("name", self.scene_id)

    @property
    def available(self) -> bool:
        return self.hub.available

    @property
    def extra_state_attributes(self) -> dict:
        return {"netroni_scene_id": self.scene_id}

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self.hub.async_add_listener(self.async_write_ha_state))
        self.async_on_remove(self.hub.async_add_scene_listener(self.scene_id, self._recalled))

    @callback
    def _recalled(self) -> None:
        """The XP-Master recalled it: by Home Assistant (already recorded), or from elsewhere."""
        if time.monotonic() < self._own_until:
            self._own_until = 0.0
            return
        self._async_record_activation()
        self.async_write_ha_state()

    async def async_activate(self, **kwargs: Any) -> None:
        self._own_until = time.monotonic() + 5
        try:
            await self.hub.client.call("scene/recall", scene_id=self.scene_id)
        except NetroniError as err:
            raise HomeAssistantError(user_message(err)) from err
