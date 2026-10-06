"""The Netroni XP-Master integration."""
from __future__ import annotations

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigEntryState
from homeassistant.const import ATTR_DEVICE_ID, Platform
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import ConfigEntryNotReady, HomeAssistantError, ServiceValidationError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.typing import ConfigType

from .client import CannotConnect, CommandError, NetroniError
from .const import ATTR_PROFILE, DOMAIN, MANUFACTURER, SERVICE_SET_PROFILE
from .hub import NetroniHub
from .sync import async_setup_label_sync

PLATFORMS = [Platform.BUTTON, Platform.LIGHT, Platform.SENSOR]

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

SET_PROFILE_SCHEMA = vol.Schema(
    {vol.Required(ATTR_DEVICE_ID): cv.string, vol.Required(ATTR_PROFILE): cv.string}
)

type NetroniConfigEntry = ConfigEntry[NetroniHub]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    async def set_profile(call: ServiceCall) -> None:
        hub, uid = _hub_for_mini_device(hass, call.data[ATTR_DEVICE_ID])
        profile = call.data[ATTR_PROFILE]
        if profile not in hub.profiles:
            raise ServiceValidationError(
                f"Unknown profile {profile!r}; choose from {', '.join(hub.profiles)}"
            )
        try:
            await hub.client.call("mini/set_profile", uid=uid, profile=profile)
        except NetroniError as err:
            raise HomeAssistantError(f"XP-Master rejected the profile change: {err}") from err

    hass.services.async_register(DOMAIN, SERVICE_SET_PROFILE, set_profile, schema=SET_PROFILE_SCHEMA)
    return True


def _hub_for_mini_device(hass: HomeAssistant, device_id: str) -> tuple[NetroniHub, str]:
    device = dr.async_get(hass).async_get(device_id)
    uid = next((i[1] for i in device.identifiers if i[0] == DOMAIN), None) if device else None
    for entry in hass.config_entries.async_entries(DOMAIN):
        if entry.state is ConfigEntryState.LOADED and uid and entry.runtime_data.mini(uid):
            return entry.runtime_data, uid
    raise ServiceValidationError("Pick an XP-Mini device of a loaded Netroni XP-Master")


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

    # Entities from an earlier profile (or an older integration version) are removed, so
    # changing a profile leaves no unavailable leftovers behind.
    ent_reg = er.async_get(hass)
    expected = hub.expected_unique_ids()
    for reg_entry in er.async_entries_for_config_entry(ent_reg, entry.entry_id):
        if reg_entry.unique_id not in expected:
            ent_reg.async_remove(reg_entry.entity_id)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(async_setup_label_sync(hass, entry, hub))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: NetroniConfigEntry) -> bool:
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        await entry.runtime_data.async_stop()
    return unloaded
