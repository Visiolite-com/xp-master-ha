"""Repairs: an offline XP-Mini (the fix removes it from the XP-Master when it was taken away), and a
new XP-Mini found while another is offline (the fix makes it that one's replacement, or confirms it
is a new XP-Mini)."""
from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.components.repairs import RepairsFlow
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant, callback
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import async_call_later
from homeassistant.helpers.selector import SelectOptionDict, SelectSelector, SelectSelectorConfig, SelectSelectorMode

from .backup import RESTORE_ISSUE, async_read_backup
from .client import NetroniClient, NetroniError, async_read_token
from .const import DOMAIN
from .replace import async_replace, replace_summary

EXTRA = "extra"  # the answer "it is a new XP-Mini", not a replacement


async def async_create_fix_flow(hass: HomeAssistant, issue_id: str, data: dict[str, Any] | None) -> RepairsFlow:
    if (data or {}).get("kind") == "replace":
        return ReplacementFlow(data or {})
    if (data or {}).get("kind") == "restore":
        return RestoreFlow(data or {})
    return RemoveOfflineMiniFlow(data or {})


class RestoreFlow(RepairsFlow):
    """Restore the XP-Master's settings saved in Home Assistant's backup (backup.py)."""

    def __init__(self, data: dict[str, Any]) -> None:
        self._entry_id = data.get("entry_id", "")

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> FlowResult:
        return await self.async_step_confirm()

    async def async_step_confirm(self, user_input: dict[str, Any] | None = None) -> FlowResult:
        entry = self.hass.config_entries.async_get_entry(self._entry_id)
        if entry is None:
            return self.async_abort(reason="resolved")
        backup = await async_read_backup(self.hass, entry.unique_id)
        if backup is None:
            return self.async_abort(reason="resolved")
        if user_input is None:
            return self.async_show_form(step_id="confirm", data_schema=vol.Schema({}))
        # Straight to the service on this machine: the entry may not be set up (another id).
        session = async_get_clientsession(self.hass)
        client = NetroniClient(session, entry.data["host"], entry.data["port"], token=await async_read_token(self.hass))
        try:
            await client.connect()
            await client.call("backup/restore", backup=backup)
        except NetroniError as err:
            return self.async_abort(reason="restore_failed", description_placeholders={"error": str(err)})
        finally:
            await client.close()
        ir.async_delete_issue(self.hass, DOMAIN, RESTORE_ISSUE + self._entry_id)
        # The service restarts with the restored settings; set the entry up again after it.
        entry_id = self._entry_id

        @callback
        def reload(_now) -> None:
            self.hass.config_entries.async_schedule_reload(entry_id)

        async_call_later(self.hass, 10, reload)
        return self.async_create_entry(data={})


class ReplacementFlow(RepairsFlow):
    """Is the new XP-Mini replacing one that is offline? Pick it, or say it is an extra one."""

    def __init__(self, data: dict[str, Any]) -> None:
        self._entry_id = data.get("entry_id", "")
        self._uid = data.get("uid", "")
        self._old = ""

    def _hub(self):
        entry = self.hass.config_entries.async_get_entry(self._entry_id)
        return entry.runtime_data if entry is not None and entry.state is ConfigEntryState.LOADED else None

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> FlowResult:
        # Home Assistant opens a repair flow with the issue as user_input: not an answer yet.
        return await self.async_step_choose()

    async def async_step_choose(self, user_input: dict[str, Any] | None = None) -> FlowResult:
        hub = self._hub()
        if hub is None:
            return self.async_abort(reason="not_loaded")
        new = hub.mini(self._uid)
        offline = [m for m in hub.config.get("minis", []) if not m.get("online", True)]
        if new is None or not new.get("replace_candidate") or not offline:
            return self.async_abort(reason="resolved")
        if user_input is not None:
            if user_input["replaces"] == EXTRA:
                try:
                    await hub.client.call("mini/confirm_new", uid=self._uid)
                except NetroniError as err:
                    return self.async_abort(reason="replace_failed", description_placeholders={"error": str(err)})
                return self.async_create_entry(data={})
            self._old = user_input["replaces"]
            return await self.async_step_confirm()
        options = [SelectOptionDict(value=m["uid"], label=f"It replaces {m['name']} ({m['uid']}), offline") for m in offline]
        options.append(SelectOptionDict(value=EXTRA, label="No, it is a new XP-Mini"))
        schema = vol.Schema(
            {vol.Required("replaces"): SelectSelector(SelectSelectorConfig(options=options, mode=SelectSelectorMode.LIST))}
        )
        return self.async_show_form(
            step_id="choose", data_schema=schema, description_placeholders={"name": new["name"], "uid": self._uid}
        )

    async def async_step_confirm(self, user_input: dict[str, Any] | None = None) -> FlowResult:
        hub = self._hub()
        if hub is None:
            return self.async_abort(reason="not_loaded")
        old, new = hub.mini(self._old), hub.mini(self._uid)
        if old is None or new is None or old.get("online", True) or not new.get("online", True):
            return self.async_abort(reason="resolved")
        if user_input is not None:
            try:
                await async_replace(hub, self._old, self._uid)
            except NetroniError as err:
                return self.async_abort(reason="replace_failed", description_placeholders={"error": str(err)})
            return self.async_create_entry(data={})
        return self.async_show_form(
            step_id="confirm", data_schema=vol.Schema({}), description_placeholders=replace_summary(hub, old, new)
        )


class RemoveOfflineMiniFlow(RepairsFlow):
    def __init__(self, data: dict[str, Any]) -> None:
        self._entry_id = data.get("entry_id", "")
        self._uid = data.get("uid", "")

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> FlowResult:
        return await self.async_step_confirm()

    async def async_step_confirm(self, user_input: dict[str, Any] | None = None) -> FlowResult:
        entry = self.hass.config_entries.async_get_entry(self._entry_id)
        if entry is None or entry.state is not ConfigEntryState.LOADED:
            return self.async_abort(reason="not_loaded")
        hub = entry.runtime_data
        mini = hub.mini(self._uid)
        if mini is None or mini.get("online", True):
            return self.async_abort(reason="resolved")  # removed or back meanwhile
        if user_input is not None:
            try:
                await hub.client.call("mini/remove", uid=self._uid)
            except NetroniError as err:
                return self.async_abort(reason="remove_failed", description_placeholders={"error": str(err)})
            return self.async_create_entry(data={})
        return self.async_show_form(
            step_id="confirm",
            data_schema=vol.Schema({}),
            description_placeholders={"name": mini["name"], "uid": self._uid},
        )
