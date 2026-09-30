"""Keeps one connection to an XP-Master and a local copy of its config and light states."""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .client import CannotConnect, CommandError, NetroniClient

_LOGGER = logging.getLogger(__name__)

MAX_RECONNECT_DELAY = 30


class NetroniHub:
    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self.client = NetroniClient(
            async_get_clientsession(hass),
            entry.data[CONF_HOST],
            entry.data[CONF_PORT],
            on_event=self._on_event,
            on_disconnect=self._on_disconnect,
        )
        self.master: dict = {}
        self.config: dict = {}
        self.states: dict[str, dict] = {}
        self.available = False
        self._listeners: set[Callable[[], None]] = set()
        self._stopping = False

    @property
    def master_id(self) -> str:
        return self.master["id"]

    # --- lifecycle ---------------------------------------------------------

    async def async_start(self) -> None:
        await self._connect_and_sync()

    async def async_stop(self) -> None:
        self._stopping = True
        await self.client.close()

    async def _connect_and_sync(self) -> None:
        await self.client.connect()
        try:
            hello = await self.client.call("hello")
            config = await self.client.call("get_config")
            states = await self.client.call("get_state")
            await self.client.call("subscribe")
        except (CannotConnect, CommandError):
            await self.client.close()
            raise
        reload_needed = bool(self.config) and _structure(config) != _structure(self.config)
        self.master, self.config, self.states = hello["master"], config, states
        self.available = True
        self._notify()
        if reload_needed:
            self._schedule_reload()

    # --- lookups -----------------------------------------------------------

    def light(self, light_id: str) -> dict | None:
        return next((l for l in self.config.get("lights", []) if l["id"] == light_id), None)

    def mini(self, uid: str) -> dict | None:
        return next((m for m in self.config.get("minis", []) if m["uid"] == uid), None)

    # --- listeners ---------------------------------------------------------

    @callback
    def async_add_listener(self, listener: Callable[[], None]) -> Callable[[], None]:
        self._listeners.add(listener)
        return lambda: self._listeners.discard(listener)

    @callback
    def _notify(self) -> None:
        for listener in list(self._listeners):
            listener()

    # --- events from the Master -------------------------------------------

    @callback
    def _on_event(self, event: str, data: dict) -> None:
        if event == "state_changed":
            self.states[data["light_id"]] = data["state"]
            self._notify()
        elif event == "config_changed":
            self.entry.async_create_background_task(
                self.hass, self._refresh_config(), "netroni refresh config"
            )

    async def _refresh_config(self) -> None:
        try:
            config = await self.client.call("get_config")
        except (CannotConnect, CommandError) as err:
            _LOGGER.debug("config refresh failed: %s", err)
            return
        reload_needed = _structure(config) != _structure(self.config)
        self.config = config
        if reload_needed:
            self._schedule_reload()
        else:
            self._notify()

    @callback
    def _on_disconnect(self) -> None:
        if self._stopping:
            return
        _LOGGER.warning("lost connection to XP-Master at %s", self.client.url)
        self.available = False
        self._notify()
        self.entry.async_create_background_task(
            self.hass, self._reconnect(), "netroni reconnect"
        )

    async def _reconnect(self) -> None:
        delay = 1
        while not self._stopping:
            await asyncio.sleep(delay)
            try:
                await self._connect_and_sync()
            except (CannotConnect, CommandError) as err:
                _LOGGER.debug("reconnect failed: %s", err)
                delay = min(delay * 2, MAX_RECONNECT_DELAY)
            else:
                _LOGGER.info("reconnected to XP-Master at %s", self.client.url)
                return

    @callback
    def _schedule_reload(self) -> None:
        """Lights or XP-Minis were added or removed: rebuild the entities."""
        self.hass.config_entries.async_schedule_reload(self.entry.entry_id)


def _structure(config: dict) -> tuple:
    """What decides which entities exist: the XP-Minis and the lights their ports produce."""
    return (
        tuple(sorted(m["uid"] for m in config.get("minis", []))),
        tuple(sorted(l["id"] for l in config.get("lights", []))),
    )
