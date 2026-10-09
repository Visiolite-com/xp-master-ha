"""Keeps one connection to an XP-Master and a local copy of its config and light states."""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import device_registry as dr, entity_registry as er, issue_registry as ir
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .client import CannotConnect, CommandError, NetroniClient
from .const import API_VERSION, DOMAIN, PORTS_PER_MINI

_LOGGER = logging.getLogger(__name__)

MAX_RECONNECT_DELAY = 30
OFFLINE_ISSUE = "mini_offline_"  # Repairs issue id prefix, followed by the XP-Mini UID


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
        self.master_device_id: str | None = None  # device registry id, set during setup
        self._listeners: set[Callable[[], None]] = set()
        self._identify_listeners: dict[str, set[Callable[[dict], None]]] = {}
        # Open port-identification notifications: notification id -> light entity ids.
        self.identify_notifications: dict[str, set[str]] = {}
        self._stopping = False
        # Platforms add entities for new lights / XP-Minis through these (see entity.async_track).
        self._structure_listeners: set[Callable[[], None]] = set()

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
            if hello.get("api_version") != API_VERSION:
                raise CommandError(
                    "incompatible_api",
                    f"Master speaks API v{hello.get('api_version')}, integration needs v{API_VERSION}",
                )
            config = await self.client.call("get_config")
            states = await self.client.call("get_state")
            await self.client.call("subscribe")
        except (CannotConnect, CommandError):
            await self.client.close()
            raise
        changed = bool(self.config) and _structure(config) != _structure(self.config)
        self.master, self.config, self.states = hello["master"], config, states
        self.available = True
        if changed:  # e.g. an XP-Mini added while we were disconnected
            self._apply_structure()
        self.async_update_offline_issues()
        self._notify()

    # --- lookups -----------------------------------------------------------

    def light(self, light_id: str) -> dict | None:
        return next((l for l in self.config.get("lights", []) if l["id"] == light_id), None)

    def mini(self, uid: str) -> dict | None:
        return next((m for m in self.config.get("minis", []) if m["uid"] == uid), None)

    def mini_online(self, uid: str) -> bool:
        mini = self.mini(uid)
        return bool(mini) and mini.get("online", True)

    def mini_lights(self, uid: str) -> list[dict]:
        return [l for l in self.config.get("lights", []) if l["mini_uid"] == uid]

    def expected_unique_ids(self) -> set[str]:
        """Unique ids of every entity the current configuration should have."""
        prefix = f"{self.master_id}_"
        ids = {prefix + light["id"] for light in self.config.get("lights", [])}
        for mini in self.config.get("minis", []):
            ids.update(
                f"{prefix}{mini['uid']}/{port}/identify" for port in range(1, PORTS_PER_MINI + 1)
            )
            ids.add(f"{prefix}{mini['uid']}/port_identified")
            ids.add(f"{prefix}{mini['uid']}/connection")
        return ids

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
        elif event == "mini_status":
            mini = self.mini(data.get("uid", ""))
            if mini is not None:
                mini["online"] = bool(data.get("online"))
                self.async_update_offline_issues()
                self._notify()
            # An XP-Mini new to the configuration arrives with config_changed.
        elif event == "port_identified":
            from .identify import async_notify_port_identified  # avoid an import cycle

            async_notify_port_identified(self.hass, self, data)
            for listener in list(self._identify_listeners.get(data.get("uid"), ())):
                listener(data)

    @callback
    def async_add_identify_listener(
        self, mini_uid: str, listener: Callable[[dict], None]
    ) -> Callable[[], None]:
        listeners = self._identify_listeners.setdefault(mini_uid, set())
        listeners.add(listener)
        return lambda: listeners.discard(listener)

    async def _refresh_config(self) -> None:
        try:
            config = await self.client.call("get_config")
        except (CannotConnect, CommandError) as err:
            _LOGGER.debug("config refresh failed: %s", err)
            return
        changed = _structure(config) != _structure(self.config)
        self.config = config
        if changed:
            self._apply_structure()
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

    # --- entities follow the configuration ----------------------------------

    @callback
    def async_add_structure_listener(self, listener: Callable[[], None]) -> Callable[[], None]:
        self._structure_listeners.add(listener)
        return lambda: self._structure_listeners.discard(listener)

    @callback
    def _apply_structure(self) -> None:
        """XP-Minis or lights were added or removed: change only the entities concerned.

        No reload of the integration: a reload briefly makes every entity unavailable, which the
        Activity log shows as false "Pressed" / "Event detected" entries.
        """
        self.async_remove_stale()
        self.async_update_offline_issues()
        for listener in list(self._structure_listeners):
            listener()

    @callback
    def async_update_offline_issues(self) -> None:
        """A Repairs issue per offline XP-Mini; it goes away when the XP-Mini is back or removed."""
        issue_reg = ir.async_get(self.hass)
        offline = {mini["uid"]: mini for mini in self.config.get("minis", []) if not mini.get("online", True)}
        for domain, issue_id in list(issue_reg.issues):
            if domain == DOMAIN and issue_id.startswith(OFFLINE_ISSUE):
                if issue_id.removeprefix(OFFLINE_ISSUE) not in offline:
                    ir.async_delete_issue(self.hass, DOMAIN, issue_id)
        for uid, mini in offline.items():
            ir.async_create_issue(
                self.hass,
                DOMAIN,
                OFFLINE_ISSUE + uid,
                is_fixable=True,
                is_persistent=False,
                severity=ir.IssueSeverity.WARNING,
                translation_key="mini_offline",
                translation_placeholders={"name": mini["name"], "uid": uid},
                data={"entry_id": self.entry.entry_id, "uid": uid},
            )

    @callback
    def async_remove_stale(self) -> None:
        """Remove entities and XP-Mini devices that the configuration no longer has."""
        ent_reg = er.async_get(self.hass)
        expected = self.expected_unique_ids()
        for reg_entry in er.async_entries_for_config_entry(ent_reg, self.entry.entry_id):
            if reg_entry.unique_id not in expected:
                ent_reg.async_remove(reg_entry.entity_id)
        dev_reg = dr.async_get(self.hass)
        known = {self.master_id} | {mini["uid"] for mini in self.config.get("minis", [])}
        for device in dr.async_entries_for_config_entry(dev_reg, self.entry.entry_id):
            uids = {ident[1] for ident in device.identifiers if ident[0] == DOMAIN}
            if uids and not uids & known:
                dev_reg.async_update_device(device.id, remove_config_entry_id=self.entry.entry_id)


def _structure(config: dict) -> tuple:
    """What decides which entities exist: the XP-Minis and the lights their ports produce."""
    return (
        tuple(sorted(m["uid"] for m in config.get("minis", []))),
        tuple(sorted(l["id"] for l in config.get("lights", []))),
    )
