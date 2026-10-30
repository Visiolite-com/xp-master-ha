"""Keeps one connection to an XP-Master and a local copy of its config and light states."""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import device_registry as dr, entity_registry as er, issue_registry as ir

from .client import AuthFailed, CannotConnect, CommandError, async_entry_token, client_for_entry
from .const import API_VERSION, DOMAIN, PORTS_PER_MINI

_LOGGER = logging.getLogger(__name__)

MAX_RECONNECT_DELAY = 30
OFFLINE_ISSUE = "mini_offline_"
REPLACE_ISSUE = "mini_new_"  # Repairs issue: is this new XP-Mini replacing one that is offline?
ALL_MINIS = "*"  # async_add_identify_listener key: every XP-Mini of this XP-Master  # Repairs issue id prefix, followed by the XP-Mini UID


class NetroniHub:
    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self.client = client_for_entry(hass, entry.data, on_event=self._on_event, on_disconnect=self._on_disconnect)
        self.master: dict = {}
        self.kind = "master"  # "stick": a Netroni Bridge Stick in the XP-Master's place (hello)
        self.config: dict = {}
        self.states: dict[str, dict] = {}
        self.group_states: dict[str, dict] = {}  # group id -> {"on", "brightness"}
        self.update_status: dict = {}  # XP-Master updates (update/status); empty: not supported
        self.mini_updates: dict[str, dict] = {}  # uid -> its last mini_update_status (firmware updates)
        self.restore_offered = False  # a backup restore is offered: keep entities the settings lack
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

    @property
    def product(self) -> str:
        """What it is, in texts: "XP-Master" or "Bridge Stick"."""
        return "Bridge Stick" if self.kind == "stick" else "XP-Master"

    # --- lifecycle ---------------------------------------------------------

    async def async_start(self) -> None:
        await self._connect_and_sync()

    async def async_stop(self) -> None:
        self._stopping = True
        await self.client.close()

    async def _connect_and_sync(self) -> None:
        self.client.token = await async_entry_token(self.hass, self.entry.data)  # the file's may be new
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
            group_states = await self._group_states()
            update_status = await self._update_status()
            await self.client.call("subscribe")
        except (CannotConnect, CommandError):
            await self.client.close()
            raise
        changed = bool(self.config) and _structure(config) != _structure(self.config)
        old = self.config
        self.master, self.config, self.states = hello["master"], config, states
        self.mini_updates = {m["uid"]: {"uid": m["uid"], **m["firmware_update"]}
                             for m in config.get("minis", []) if m.get("firmware_update")}
        self.kind = hello.get("kind") or "master"
        self._apply_renames(old)
        self.group_states = group_states
        self.update_status = update_status
        self.available = True
        if changed:  # e.g. an XP-Mini added while we were disconnected
            self._apply_structure()
        self.async_update_offline_issues()
        self._update_hidden()
        self._notify()

    @callback
    def _apply_renames(self, old: dict) -> None:
        from .sync import async_apply_renames  # avoid an import cycle

        async_apply_renames(self.hass, self, old, self.config)

    @callback
    def _update_hidden(self) -> None:
        from .sync import async_update_hidden  # avoid an import cycle

        async_update_hidden(self.hass, self)

    async def _update_status(self) -> dict:
        try:
            return await self.client.call("update/status")
        except CommandError:  # a Netroni service from before updates, or updates disabled
            return {}

    async def _group_states(self) -> dict:
        try:
            return await self.client.call("group/get_state")
        except CommandError:  # a Netroni service from before groups
            return {}

    # --- lookups -----------------------------------------------------------

    def group(self, group_id: str) -> dict | None:
        return next((g for g in self.config.get("groups", []) if g["id"] == group_id), None)

    def light(self, light_id: str) -> dict | None:
        return next((l for l in self.config.get("lights", []) if l["id"] == light_id), None)

    def mini(self, uid: str) -> dict | None:
        return next((m for m in self.config.get("minis", []) if m["uid"] == uid), None)

    def device(self, identifier: str) -> dr.DeviceEntry | None:
        """This entry's device for the XP-Master's id or an XP-Mini's uid. Identifiers are unique
        within a config entry only: two XP-Masters can have XP-Minis with the same uid."""
        return next(
            (
                device
                for device in dr.async_entries_for_config_entry(dr.async_get(self.hass), self.entry.entry_id)
                if (DOMAIN, identifier) in device.identifiers
            ),
            None,
        )

    def mini_online(self, uid: str) -> bool:
        mini = self.mini(uid)
        return bool(mini) and mini.get("online", True)

    def mini_lights(self, uid: str) -> list[dict]:
        return [l for l in self.config.get("lights", []) if l["mini_uid"] == uid]

    def expected_unique_ids(self) -> set[str]:
        """Unique ids of every entity the current configuration should have."""
        prefix = f"{self.master_id}_"
        ids = {prefix + light["id"] for light in self.config.get("lights", [])}
        ids.add(f"{prefix}firmware")
        ids.update(f"{prefix}group/{group['id']}" for group in self.config.get("groups", []))
        for mini in self.config.get("minis", []):
            ids.update(
                f"{prefix}{mini['uid']}/{port}/identify" for port in range(1, PORTS_PER_MINI + 1)
            )
            ids.add(f"{prefix}{mini['uid']}/port_identified")
            ids.add(f"{prefix}{mini['uid']}/restart")
            ids.add(f"{prefix}{mini['uid']}/firmware")
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
        elif event == "group_changed":
            self.group_states[data["group_id"]] = data["state"]
            self._notify()
        elif event == "group_removed":
            self.group_states.pop(data["group_id"], None)
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
        elif event == "mini_update_status":
            self.mini_updates[data.get("uid", "")] = data
            self._notify()
        elif event == "update_status":
            release = self.update_status.get("installed")
            self.update_status = data
            if data.get("installed") != release and self.master_device_id:
                dr.async_get(self.hass).async_update_device(self.master_device_id, sw_version=data.get("installed"))
            self._notify()
        elif event == "port_identified":
            from .identify import async_notify_port_identified  # avoid an import cycle

            async_notify_port_identified(self.hass, self, data)
            listeners = self._identify_listeners.get(data.get("uid"), set()) | self._identify_listeners.get(ALL_MINIS, set())
            for listener in list(listeners):
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
        if changed:
            # New lights need a state before their entities count as available; the Master
            # announces them, this re-read also covers an announcement missed in between.
            try:
                self.states.update(await self.client.call("get_state"))
                self.group_states.update(await self._group_states())
            except (CannotConnect, CommandError) as err:
                _LOGGER.debug("state refresh failed: %s", err)
        old, self.config = self.config, config
        for mini in config.get("minis", []):
            if mini.get("firmware_update"):
                self.mini_updates[mini["uid"]] = {"uid": mini["uid"], **mini["firmware_update"]}
        self.master = config.get("master") or self.master
        self._apply_renames(old)
        if changed:
            self._apply_structure()
        self.async_update_offline_issues()
        self._update_devices()
        self._update_hidden()
        self._notify()

    @callback
    def _update_devices(self) -> None:
        """Serial number and firmware follow the unit installed (they change with a replacement)."""
        dev_reg = dr.async_get(self.hass)
        devices = {
            ident[1]: device
            for device in dr.async_entries_for_config_entry(dev_reg, self.entry.entry_id)
            for ident in device.identifiers
            if ident[0] == DOMAIN
        }
        for mini in self.config.get("minis", []):
            device = devices.get(mini["uid"])
            if device is None:
                continue
            serial = mini.get("hardware_uid") or mini["uid"]
            firmware = mini.get("firmware") or device.sw_version
            if device.serial_number != serial or device.sw_version != firmware:
                dev_reg.async_update_device(device.id, serial_number=serial, sw_version=firmware)

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
            except AuthFailed as err:
                # Remote access removed on the XP-Master, or another certificate: pair again.
                _LOGGER.warning("XP-Master at %s refused this Home Assistant: %s", self.client.url, err)
                self.entry.async_start_reauth(self.hass)
                return
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
        """A Repairs issue per offline XP-Mini; it goes away when the XP-Mini is back or removed.
        And one per new XP-Mini that may replace an offline one, until that is answered."""
        issue_reg = ir.async_get(self.hass)
        minis = self.config.get("minis", [])
        offline = {mini["uid"]: mini for mini in minis if not mini.get("online", True)}
        candidates = {m["uid"]: m for m in minis if m.get("replace_candidate") and m.get("online", True)} if offline else {}
        for domain, issue_id in list(issue_reg.issues):
            if domain != DOMAIN:
                continue
            if issue_id.startswith(OFFLINE_ISSUE) and issue_id.removeprefix(OFFLINE_ISSUE) not in offline:
                ir.async_delete_issue(self.hass, DOMAIN, issue_id)
            if issue_id.startswith(REPLACE_ISSUE) and issue_id.removeprefix(REPLACE_ISSUE) not in candidates:
                ir.async_delete_issue(self.hass, DOMAIN, issue_id)
        for uid, mini in candidates.items():
            ir.async_create_issue(
                self.hass,
                DOMAIN,
                REPLACE_ISSUE + uid,
                is_fixable=True,
                is_persistent=False,
                severity=ir.IssueSeverity.WARNING,
                translation_key="mini_replacement",
                translation_placeholders={"name": mini["name"], "uid": uid},
                data={"entry_id": self.entry.entry_id, "uid": uid, "kind": "replace"},
            )
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
        if self.restore_offered:
            return
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
                dev_reg.async_remove_device(device.id)


def _structure(config: dict) -> tuple:
    """What decides which entities exist: the XP-Minis and the lights their ports produce."""
    return (
        tuple(sorted(m["uid"] for m in config.get("minis", []))),
        tuple(sorted(l["id"] for l in config.get("lights", []))),
        tuple(sorted(g["id"] for g in config.get("groups", []))),
    )
