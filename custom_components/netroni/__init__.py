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
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.typing import ConfigType

from .client import CannotConnect, CommandError, NetroniError
from .const import (
    ATTR_PORT,
    DOMAIN,
    MANUFACTURER,
    PORTS_PER_MINI,
    SERVICE_PAIR,
    SERVICE_UNPAIR,
    SIGNAL_HUBS_CHANGED,
)
from .hub import NetroniHub
from .panel import async_setup_panel
from .sync import async_setup_label_sync
from .websocket import async_setup_websocket

PLATFORMS = [Platform.BINARY_SENSOR, Platform.BUTTON, Platform.EVENT, Platform.LIGHT]

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

PORT_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_DEVICE_ID): cv.string,
        vol.Required(ATTR_PORT): vol.All(vol.Coerce(int), vol.Range(min=1, max=PORTS_PER_MINI)),
    }
)

type NetroniConfigEntry = ConfigEntry[NetroniHub]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    def make_handler(command: str):
        async def handle(call: ServiceCall) -> None:
            hub, uid = _hub_for_mini_device(hass, call.data[ATTR_DEVICE_ID])
            try:
                await hub.client.call(command, uid=uid, port=call.data[ATTR_PORT])
            except NetroniError as err:
                raise HomeAssistantError(f"XP-Master rejected the change: {err}") from err

        return handle

    hass.services.async_register(DOMAIN, SERVICE_PAIR, make_handler("mini/pair"), schema=PORT_SCHEMA)
    hass.services.async_register(DOMAIN, SERVICE_UNPAIR, make_handler("mini/unpair"), schema=PORT_SCHEMA)
    async_setup_websocket(hass)
    await async_setup_panel(hass)
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

    # Entities and devices that no longer match the configuration (lights of a port that was
    # paired or unpaired, removed XP-Minis, older integration versions) are removed.
    hub.async_remove_stale()

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(async_setup_label_sync(hass, entry, hub))
    async_dispatcher_send(hass, SIGNAL_HUBS_CHANGED)
    return True


async def async_remove_config_entry_device(
    hass: HomeAssistant, entry: NetroniConfigEntry, device: dr.DeviceEntry
) -> bool:
    """Home Assistant's "Delete" on an XP-Mini's device page: the XP-Master forgets it (lights, names,
    DMX block). Only for an XP-Mini that was disconnected; a connected one would be found again at
    once, so that is refused (Factory reset, under Configure, is for that)."""
    hub = entry.runtime_data
    uid = next((ident[1] for ident in device.identifiers if ident[0] == DOMAIN), None)
    if uid is None or uid == hub.master_id:
        raise HomeAssistantError("The XP-Master itself cannot be deleted; delete the integration entry instead")
    mini = hub.mini(uid)
    if mini is None:
        return True  # the XP-Master no longer has it
    if mini.get("online", True):
        raise HomeAssistantError(
            f"{mini['name']} is still connected. Disconnect it first, or use Factory reset (Configure) "
            "to start it afresh."
        )
    try:
        await hub.client.call("mini/remove", uid=uid)
    except NetroniError as err:
        raise HomeAssistantError(f"The XP-Master did not remove {mini['name']}: {err}") from err
    return True


async def async_unload_entry(hass: HomeAssistant, entry: NetroniConfigEntry) -> bool:
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        await entry.runtime_data.async_stop()
        async_dispatcher_send(hass, SIGNAL_HUBS_CHANGED)
    return unloaded
