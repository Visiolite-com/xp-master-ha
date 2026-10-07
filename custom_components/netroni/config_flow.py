"""Config flow: manual entry or zeroconf discovery of an XP-Master."""
from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import (
    ConfigEntry,
    ConfigEntryState,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.selector import (
    SelectOptionDict,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
)
from homeassistant.helpers.service_info.zeroconf import ZeroconfServiceInfo

from .client import CannotConnect, CommandError, NetroniClient, NetroniError
from .const import CHANNEL_PAIRS, DEFAULT_PORT, DOMAIN


class NetroniConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> NetroniOptionsFlow:
        return NetroniOptionsFlow()

    def __init__(self) -> None:
        self._host = ""
        self._port = DEFAULT_PORT
        self._name = ""

    async def _probe(self, host: str, port: int) -> dict:
        client = NetroniClient(async_get_clientsession(self.hass), host, port)
        await client.connect()
        try:
            return await client.call("hello")
        finally:
            await client.close()

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            host, port = user_input[CONF_HOST], user_input[CONF_PORT]
            try:
                hello = await self._probe(host, port)
            except (CannotConnect, CommandError):
                errors["base"] = "cannot_connect"
            else:
                await self.async_set_unique_id(hello["master"]["id"])
                self._abort_if_unique_id_configured(updates={CONF_HOST: host, CONF_PORT: port})
                return self.async_create_entry(
                    title=hello["master"]["name"], data={CONF_HOST: host, CONF_PORT: port}
                )
        schema = vol.Schema(
            {
                vol.Required(CONF_HOST, default=(user_input or {}).get(CONF_HOST, "")): str,
                vol.Required(CONF_PORT, default=DEFAULT_PORT): int,
            }
        )
        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)

    async def async_step_zeroconf(self, discovery_info: ZeroconfServiceInfo) -> ConfigFlowResult:
        master_id = discovery_info.properties.get("id")
        if not master_id:
            return self.async_abort(reason="not_netroni")
        self._host, self._port = discovery_info.host, discovery_info.port or DEFAULT_PORT
        self._name = discovery_info.name.split(".")[0]
        await self.async_set_unique_id(master_id)
        self._abort_if_unique_id_configured(updates={CONF_HOST: self._host, CONF_PORT: self._port})
        self.context["title_placeholders"] = {"name": self._name}
        return await self.async_step_zeroconf_confirm()

    async def async_step_zeroconf_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(
                title=self._name, data={CONF_HOST: self._host, CONF_PORT: self._port}
            )
        self._set_confirm_only()
        return self.async_show_form(
            step_id="zeroconf_confirm",
            description_placeholders={"name": self._name, "host": self._host},
        )


class NetroniOptionsFlow(OptionsFlow):
    """Configure: choose which of an XP-Mini's channels are paired into tunable-white lights."""

    def __init__(self) -> None:
        self._uid = ""
        self._pair: list[int] = []
        self._unpair: list[int] = []

    @property
    def _hub(self):
        return self.config_entry.runtime_data

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if self.config_entry.state is not ConfigEntryState.LOADED:
            return self.async_abort(reason="not_loaded")
        if user_input is not None:
            self._uid = user_input["mini"]
            return await self.async_step_channels()
        options = [
            SelectOptionDict(value=m["uid"], label=f"{m['name']} ({m['uid']}) · {_pairs_text(m['pairs'])}")
            for m in self._hub.config.get("minis", [])
        ]
        schema = vol.Schema(
            {vol.Required("mini"): SelectSelector(SelectSelectorConfig(options=options, mode=SelectSelectorMode.LIST))}
        )
        return self.async_show_form(step_id="init", data_schema=schema)

    async def async_step_channels(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        mini = self._hub.mini(self._uid)
        if mini is None:
            return self.async_abort(reason="mini_gone")
        current = set(mini["pairs"])
        if user_input is not None:
            wanted = {int(c) for c in user_input["paired"]}
            self._pair, self._unpair = sorted(wanted - current), sorted(current - wanted)
            if not self._pair and not self._unpair:
                return self.async_abort(reason="no_changes")
            return await self.async_step_confirm()
        options = [
            SelectOptionDict(value=str(ch), label=f"Ch{ch}A + Ch{ch}B → Ch{ch} TW")
            for ch in range(1, CHANNEL_PAIRS + 1)
        ]
        schema = vol.Schema(
            {
                vol.Optional("paired", default=[str(c) for c in sorted(current)]): SelectSelector(
                    SelectSelectorConfig(options=options, multiple=True, mode=SelectSelectorMode.LIST)
                )
            }
        )
        return self.async_show_form(
            step_id="channels", data_schema=schema, description_placeholders={"mini": mini["name"]}
        )

    async def async_step_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        mini = self._hub.mini(self._uid)
        if mini is None:
            return self.async_abort(reason="mini_gone")
        if user_input is not None:
            try:
                for ch in self._pair:
                    await self._hub.client.call("mini/pair", uid=self._uid, channel=ch)
                for ch in self._unpair:
                    await self._hub.client.call("mini/unpair", uid=self._uid, channel=ch)
            except NetroniError as err:
                return self.async_abort(reason="set_failed", description_placeholders={"error": str(err)})
            return self.async_create_entry(data=dict(self.config_entry.options))
        changes = [f"Ch{c}A + Ch{c}B become Ch{c} TW" for c in self._pair]
        changes += [f"Ch{c} TW becomes Ch{c}A and Ch{c}B" for c in self._unpair]
        return self.async_show_form(
            step_id="confirm",
            data_schema=vol.Schema({}),
            description_placeholders={"mini": mini["name"], "changes": "\n".join(f"- {c}" for c in changes)},
        )


def _pairs_text(pairs: list[int]) -> str:
    return "TW: " + ", ".join(f"Ch{c}" for c in pairs) if pairs else "no TW pairs"
