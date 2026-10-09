"""Repairs: an offline XP-Mini. The fix removes it from the XP-Master when it was taken away."""
from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.components.repairs import RepairsFlow
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResult

from .client import NetroniError


async def async_create_fix_flow(hass: HomeAssistant, issue_id: str, data: dict[str, Any] | None) -> RepairsFlow:
    return RemoveOfflineMiniFlow(data or {})


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
