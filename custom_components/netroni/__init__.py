"""The Netroni XP-Master integration."""
from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryNotReady
from homeassistant.helpers import device_registry as dr

from .client import CannotConnect, CommandError
from .const import DOMAIN, MANUFACTURER
from .hub import NetroniHub
from .sync import async_setup_label_sync

PLATFORMS = [Platform.BUTTON, Platform.LIGHT, Platform.SELECT]

type NetroniConfigEntry = ConfigEntry[NetroniHub]


async def async_setup_entry(hass: HomeAssistant, entry: NetroniConfigEntry) -> bool:
    hub = NetroniHub(hass, entry)
    try:
        await hub.async_start()
    except (CannotConnect, CommandError) as err:
        raise ConfigEntryNotReady(str(err)) from err
    entry.runtime_data = hub

    master_device = dr.async_get(hass).async_get_or_create(
        config_entry_id=entry.entry_id,
        identifiers={(DOMAIN, hub.master_id)},
        manufacturer=MANUFACTURER,
        model="XP-Master",
        name=hub.master.get("name", "XP-Master"),
        serial_number=hub.master_id,
    )
    hub.master_device_id = master_device.id

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(async_setup_label_sync(hass, entry, hub))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: NetroniConfigEntry) -> bool:
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        await entry.runtime_data.async_stop()
    return unloaded
