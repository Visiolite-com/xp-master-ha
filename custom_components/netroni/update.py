"""XP-Master firmware: one update entity on the XP-Master device (Settings → Updates).

The Netroni service checks Visiolite's update server (every 3 days; "Check for updates" asks at
once), downloads and verifies a release and hands it to the XP-Master's updater, which installs it
and restarts the containers, Home Assistant included. Progress comes as update_status events.
"""
from __future__ import annotations

from typing import Any

from homeassistant.components.update import UpdateEntity, UpdateEntityFeature
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import NetroniConfigEntry
from .client import CommandError, NetroniError
from .const import DOMAIN
from .hub import NetroniHub

BRIDGE_NOTE = "This update includes the bridge firmware: the lights don't respond for a few seconds while it is installed."


async def async_setup_entry(
    hass: HomeAssistant,
    entry: NetroniConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    async_add_entities([XpMasterUpdate(entry.runtime_data)])


class XpMasterUpdate(UpdateEntity):
    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_entity_category = EntityCategory.CONFIG
    _attr_translation_key = "firmware"
    _attr_supported_features = UpdateEntityFeature.INSTALL | UpdateEntityFeature.PROGRESS

    def __init__(self, hub: NetroniHub) -> None:
        self.hub = hub
        self._attr_unique_id = f"{hub.master_id}_firmware"
        self._attr_device_info = DeviceInfo(identifiers={(DOMAIN, hub.master_id)})

    @property
    def _status(self) -> dict:
        return self.hub.update_status

    @property
    def available(self) -> bool:
        return self.hub.available and bool(self._status)

    @property
    def installed_version(self) -> str | None:
        return self._status.get("installed")

    @property
    def latest_version(self) -> str | None:
        latest = self._status.get("latest")
        if latest and self._status.get("update_available"):
            return latest["release"]
        return self.installed_version  # up to date (or nothing newer known yet)

    @property
    def release_url(self) -> str | None:
        return (self._status.get("latest") or {}).get("notes_url")

    @property
    def release_summary(self) -> str | None:
        latest = self._status.get("latest") or {}
        parts = []
        if self._status.get("blocked") and self._status.get("update_available"):
            parts.append(f"Cannot be installed: {self._status['blocked']}.")
        if latest.get("summary"):
            parts.append(latest["summary"])
        if latest.get("includes_bridge"):
            parts.append(BRIDGE_NOTE)
        if self._status.get("state") == "failed" and self._status.get("error"):
            parts.append(f"The last attempt failed: {self._status['error']}.")
        return " ".join(parts)[:255] or None

    @property
    def in_progress(self) -> bool:
        return self._status.get("state") in ("downloading", "installing")

    @property
    def update_percentage(self) -> int | None:
        if not self.in_progress:
            return None
        progress = self._status.get("progress")
        if self._status.get("state") == "downloading" and progress is not None:
            return int(progress * 0.4)  # downloading is the first 40 %, the host does the rest
        if progress is not None:
            return 40 + int(progress * 0.6)
        return None

    async def async_install(self, version: str | None, backup: bool, **kwargs: Any) -> None:
        """Starts the download and the install; it continues on the XP-Master (with restarts)."""
        try:
            await self.hub.client.call("update/install", **({"release": version} if version else {}))
        except CommandError as err:
            raise HomeAssistantError(f"The XP-Master cannot install this update: {str(err).split(': ', 1)[-1]}") from err
        except NetroniError as err:
            raise HomeAssistantError(f"Cannot reach the XP-Master: {err}") from err

    async def async_update(self) -> None:
        """Settings → Updates → Check for updates (homeassistant.update_entity): ask the server now."""
        try:
            self.hub.update_status = await self.hub.client.call("update/check")
        except NetroniError as err:
            raise HomeAssistantError(f"Cannot check for updates: {err}") from err

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self.hub.async_add_listener(self.async_write_ha_state))
