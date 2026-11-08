"""Keeps one connection to an XP-Master and a local copy of its config and light states."""
from __future__ import annotations

import asyncio
import logging
import random
import time
from collections.abc import Callable

from homeassistant.components import persistent_notification
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import device_registry as dr, entity_registry as er, issue_registry as ir

from .client import AuthFailed, CannotConnect, CommandError, _hex, async_entry_token, client_for_entry
from .const import API_VERSION, CONF_FINGERPRINT, CONF_NEXT_FINGERPRINT, DOMAIN, PORTS_PER_MINI

_LOGGER = logging.getLogger(__name__)

MAX_RECONNECT_DELAY = 30
STABLE_AFTER = 60  # s connected before a lost connection starts the backoff afresh
OFFLINE_ISSUE = "mini_offline_"
REPLACE_ISSUE = "mini_new_"  # Repairs issue: is this new XP-Mini replacing one that is offline?
ALL_MINIS = "*"  # async_add_identify_listener key: every XP-Mini of this XP-Master  # Repairs issue id prefix, followed by the XP-Mini UID


class NetroniHub:
    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self.client = client_for_entry(hass, entry.data, on_event=self._on_event, on_disconnect=self._on_disconnect)
        self.master: dict = {}
        self.kind = "master"  # "stick": an XP-Bridge in the XP-Master's place (hello)
        self.config: dict = {}
        self.states: dict[str, dict] = {}
        self.group_states: dict[str, dict] = {}  # group id -> {"on", "brightness"}
        self.update_status: dict = {}  # XP-Master updates (update/status); empty: not supported
        self.mini_updates: dict[str, dict] = {}  # uid -> its last mini_update_status (firmware updates)
        self.pack_updates: dict[str, dict] = {}  # uid -> its last pack_update_status (X-Pack firmware)
        self.restore_offered = False  # a backup restore is offered: keep entities the settings lack
        self.available = False
        self.master_device_id: str | None = None  # device registry id, set during setup
        self._listeners: set[Callable[[], None]] = set()
        self._identify_listeners: dict[str, set[Callable[[dict], None]]] = {}
        self._input_listeners: dict[tuple[str, int], set[Callable[[str], None]]] = {}
        self._scene_listeners: dict[str, set[Callable[[], None]]] = {}
        # Open port-identification notifications: notification id -> light entity ids.
        self.identify_notifications: dict[str, set[str]] = {}
        self._stopping = False
        # Reconnecting: a connection lost soon after it was made (a device starting up, or one short of
        # memory closing it) backs off further, so a device coming back is not hammered.
        self._connected_at = 0.0
        self._reconnect_delay = 0.0
        # Platforms add entities for new lights / XP-Minis through these (see entity.async_track).
        self._structure_listeners: set[Callable[[], None]] = set()

    @property
    def master_id(self) -> str:
        return self.master["id"]

    @property
    def entity_prefix(self) -> str:
        """What the XP-Minis', lights' and groups' unique ids start with: the installation (visiolink
        docs/ids.md), so they stay the same when the XP-Master or XP-Bridge is replaced; an older
        XP-Master without one: its id."""
        installation = self.config.get("installation") or ""
        return installation if installation.strip("0") else self.master_id

    @property
    def product(self) -> str:
        """What it is, in texts: "XP-Master" or "XP-Bridge"."""
        return "XP-Bridge" if self.kind == "stick" else "XP-Master"

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
            await self._take_keys(hello.get("key_rotation"))
        except (CannotConnect, CommandError):
            await self.client.close()
            raise
        self._connected_at = time.monotonic()
        changed = bool(self.config) and _structure(config) != _structure(self.config)
        old = self.config
        old_prefix = self.entity_prefix if self.config else None
        self.master, self.config, self.states = hello["master"], config, states
        self.mini_updates = {m["uid"]: {"uid": m["uid"], **m["firmware_update"]}
                             for m in config.get("minis", []) if m.get("firmware_update")}
        self.kind = hello.get("kind") or "master"
        self.async_migrate_unique_ids(old_prefix)
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
        """The groups' states. Only a Netroni service from before groups has none; any other error is
        raised, so the connection is tried again: taken as "no groups", every group light would stay
        unavailable until its next change (seen once after an XP-Bridge restart)."""
        try:
            return await self.client.call("group/get_state")
        except CommandError as err:
            if err.code == "unknown_command":
                return {}
            raise

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
        prefix = f"{self.entity_prefix}_"
        ids = {prefix + light["id"] for light in self.config.get("lights", [])}
        ids.add(f"{self.master_id}_firmware")
        ids.update(f"{prefix}group/{group['id']}" for group in self.config.get("groups", []))
        ids.update(f"{prefix}scene/{scene['id']}" for scene in self.config.get("scenes", []))
        for mini in self.config.get("minis", []):
            ids.update(
                f"{prefix}{mini['uid']}/{port}/identify" for port in range(1, PORTS_PER_MINI + 1)
            )
            ids.add(f"{prefix}{mini['uid']}/port_identified")
            ids.add(f"{prefix}{mini['uid']}/restart")
            ids.add(f"{prefix}{mini['uid']}/firmware")
        for pack in self.config.get("packs", []):
            ids.update(f"{prefix}{pack['uid']}/input{i['input']}" for i in pack.get("inputs", []))
            ids.add(f"{prefix}{pack['uid']}/firmware")
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
    async def _take_keys(self, rotation: dict | None) -> None:
        """Remote access: the XP-Master's keys being renewed (docs/key-rotation.md in xp-master). The
        next certificate is kept as a second pin and confirmed; met once, it becomes the only one."""
        data = self.entry.data
        if not data.get(CONF_FINGERPRINT):
            return  # the local API: nothing pinned
        current, nxt = data[CONF_FINGERPRINT], data.get(CONF_NEXT_FINGERPRINT)
        served = self.client.served_fingerprint
        if nxt and served == _hex(nxt):  # switched: the next one is now the certificate
            current, nxt = nxt, None
            _LOGGER.info("%s: its renewed certificate is now the one pinned", self.entry.title)
        if rotation is not None and rotation.get("fingerprint"):
            nxt = rotation["fingerprint"]
        elif nxt and served == _hex(current):  # nothing under way any more, and not switched: dropped
            nxt = None
        if (current, nxt) != (data[CONF_FINGERPRINT], data.get(CONF_NEXT_FINGERPRINT)):
            self.hass.config_entries.async_update_entry(
                self.entry, data={**data, CONF_FINGERPRINT: current, CONF_NEXT_FINGERPRINT: nxt})
            self.client.set_fingerprints(current, nxt)
        if rotation is not None and nxt:  # kept: now say so (again on each connection: harmless)
            await self.client.call("remote/confirm_keys", fingerprint=rotation["fingerprint"])

    async def _take_keys_quietly(self, rotation: dict | None) -> None:
        """A change starting (the event). Its end (None) changes nothing here: this connection is still
        on the old certificate; the next one meets the new (hello's _take_keys)."""
        if rotation is None:
            return
        try:
            await self._take_keys(rotation)
        except (CannotConnect, CommandError) as err:  # the next connection's hello tries again
            _LOGGER.warning("%s: could not take its renewed keys yet: %s", self.entry.title, err)

    def _on_event(self, event: str, data: dict) -> None:
        if event == "key_rotation":
            self.entry.async_create_background_task(self.hass, self._take_keys_quietly(data), "netroni keys")
        elif event == "state_changed":
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
        elif event == "pack_update_status":
            self.pack_updates[data.get("uid", "")] = data
            self._notify()
        elif event == "packs_changed":
            old = _structure(self.config)
            self.config["packs"] = data.get("packs", [])
            if _structure(self.config) != old:
                self._apply_structure()
            self._notify()
        elif event == "scene_recalled":
            for listener in list(self._scene_listeners.get(data.get("scene_id"), set())):
                listener()
        elif event == "input_event":
            for listener in list(self._input_listeners.get((data.get("uid"), data.get("input")), set())):
                listener(data.get("event", "pressed"))
        elif event in ("remote_paired", "remote_outside"):
            self._notify_remote(event, data)
        elif event == "port_identified":
            from .identify import async_notify_port_identified  # avoid an import cycle

            async_notify_port_identified(self.hass, self, data)
            listeners = self._identify_listeners.get(data.get("uid"), set()) | self._identify_listeners.get(ALL_MINIS, set())
            for listener in list(listeners):
                listener(data)

    @callback
    def _notify_remote(self, event: str, data: dict) -> None:
        """A new pairing, or a paired app's first connection from outside the home: told to the admins,
        so one they don't expect is noticed (security review 2026-11-08)."""
        master = self.master.get("name") or self.product
        name = data.get("name") or "A client"
        if event == "remote_paired":
            title = f"Paired with {master}"
            message = (f"**{name}** was paired with {master} and can now control it. If you don't know it, "
                       "remove it in the Netroni panel → Remote Access.")
        else:
            title = f"{master} used from outside the home"
            message = (f"**{name}** connected to {master} from outside the home for the first time, through the "
                       "Visiolite relay. If you don't expect that, remove it in the Netroni panel → Remote Access, "
                       "or turn off Access from outside the home in the panel's Settings.")
        persistent_notification.async_create(
            self.hass, message, title, f"{DOMAIN}_{event}_{self.master_id}_{data.get('client_id', '')}"
        )

    @callback
    def async_add_identify_listener(
        self, mini_uid: str, listener: Callable[[dict], None]
    ) -> Callable[[], None]:
        listeners = self._identify_listeners.setdefault(mini_uid, set())
        listeners.add(listener)
        return lambda: listeners.discard(listener)

    @callback
    def async_add_input_listener(self, pack_uid: str, number: int, listener: Callable[[str], None]) -> Callable[[], None]:
        """Be told of each press of an X-Pack's input ("pressed", "turned_on", "turned_off")."""
        listeners = self._input_listeners.setdefault((pack_uid, number), set())
        listeners.add(listener)
        return lambda: listeners.discard(listener)

    @callback
    def async_add_scene_listener(self, scene_id: str, listener: Callable[[], None]) -> Callable[[], None]:
        """Be told of each recall of a scene, wherever it came from (Home Assistant, the app, a button)."""
        listeners = self._scene_listeners.setdefault(scene_id, set())
        listeners.add(listener)
        return lambda: listeners.discard(listener)

    def pack(self, uid: str) -> dict | None:
        return next((p for p in self.config.get("packs", []) if p["uid"] == uid), None)

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
        old_prefix = self.entity_prefix
        old, self.config = self.config, config
        self.async_migrate_unique_ids(old_prefix)
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
        if time.monotonic() - self._connected_at >= STABLE_AFTER:
            self._reconnect_delay = 1
        else:  # it did not last: wait longer than last time
            self._reconnect_delay = min(max(self._reconnect_delay, 1) * 2, MAX_RECONNECT_DELAY)
        self.entry.async_create_background_task(
            self.hass, self._reconnect(self._reconnect_delay), "netroni reconnect"
        )

    async def _reconnect(self, delay: float) -> None:
        while not self._stopping:
            await asyncio.sleep(delay * random.uniform(0.8, 1.2))  # not in step with other clients
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
                self._reconnect_delay = delay
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
    def async_migrate_unique_ids(self, old_prefix: str | None = None) -> None:
        """Entities of this entry still on the XP-Master's id ("XPM-E177_<light>"), once it has an
        installation, or on another installation (the XP-Bridge set up afresh took another one):
        onto the installation's ("<installation>_<light>"), keeping their entity ids, names and
        areas, so automations go on working."""
        prefix = self.entity_prefix
        olds = [f"{p}_" for p in {self.master_id, old_prefix} if p and p != prefix]
        if not olds:
            return
        ent_reg = er.async_get(self.hass)
        for reg_entry in er.async_entries_for_config_entry(ent_reg, self.entry.entry_id):
            old = next((o for o in olds if reg_entry.unique_id.startswith(o)), None)
            rest = reg_entry.unique_id.removeprefix(old) if old else ""
            if not rest or rest == "firmware":
                continue
            new = f"{prefix}_{rest}"
            if ent_reg.async_get_entity_id(reg_entry.domain, DOMAIN, new) is None:
                ent_reg.async_update_entity(reg_entry.entity_id, new_unique_id=new)
                _LOGGER.debug("%s: unique id %s -> %s", reg_entry.entity_id, reg_entry.unique_id, new)

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
        known = ({self.master_id} | {mini["uid"] for mini in self.config.get("minis", [])}
                 | {pack["uid"] for pack in self.config.get("packs", [])})
        for device in dr.async_entries_for_config_entry(dev_reg, self.entry.entry_id):
            uids = {ident[1] for ident in device.identifiers if ident[0] == DOMAIN}
            if uids and not uids & known:
                dev_reg.async_remove_device(device.id)


def _structure(config: dict) -> tuple:
    """What decides which entities exist: the XP-Minis, the lights their ports produce, groups, scenes."""
    return (
        tuple(sorted(m["uid"] for m in config.get("minis", []))),
        tuple(sorted(l["id"] for l in config.get("lights", []))),
        tuple(sorted(g["id"] for g in config.get("groups", []))),
        tuple(sorted(sc["id"] for sc in config.get("scenes", []))),
        tuple(sorted((p["uid"], len(p.get("inputs", []))) for p in config.get("packs", []))),
    )
