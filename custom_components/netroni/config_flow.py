"""Config flow: zeroconf discovery or manual entry of an XP-Master.

The XP-Master this Home Assistant runs on is added by itself (the local API and its token file).
Another XP-Master on the LAN is paired through its remote access: a code from its Netroni panel
(Remote Access) and its front display, over TLS with its certificate pinned (docs/remote-access.md).
"""
from __future__ import annotations

import asyncio

from typing import Any

import voluptuous as vol

from collections.abc import Mapping

from homeassistant.config_entries import SOURCE_REAUTH, ConfigFlow, ConfigFlowResult
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.service_info.zeroconf import ZeroconfServiceInfo

from .client import (
    CannotConnect,
    CommandError,
    NetroniClient,
    async_fetch_certificate,
    async_fetch_fingerprint,
    async_pair,
    async_read_token,
)
from .const import CONF_FINGERPRINT, CONF_TOKEN, DEFAULT_PORT, DOMAIN, REMOTE_PORT

LOCALHOST = "127.0.0.1"  # Home Assistant and the Netroni service share the host network


class NetroniConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    def __init__(self) -> None:
        self._host = ""
        self._port = DEFAULT_PORT
        self._name = ""
        self._master_id = ""  # its serial, as on its display (unknown when added by address)
        self._fingerprint = ""  # remote access: hex SHA-256 of the XP-Master's certificate
        self._bridge = False  # an XP-Bridge: paired by its button, not a code
        self._pair_task: asyncio.Task | None = None
        self._pair_reply: dict = {}

    async def _probe(self, host: str, port: int) -> dict:
        client = NetroniClient(async_get_clientsession(self.hass), host, port, token=await async_read_token(self.hass))
        await client.connect()
        try:
            return await client.call("hello")
        finally:
            await client.close()

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            host = user_input[CONF_HOST].strip()
            try:  # the XP-Master this Home Assistant runs on: its local API
                hello = await self._probe(host, DEFAULT_PORT)
            except (CannotConnect, CommandError):
                hello = None
            if hello is not None:
                await self.async_set_unique_id(hello["master"]["id"])
                self._abort_if_unique_id_configured(updates={CONF_HOST: host, CONF_PORT: DEFAULT_PORT})
                return self.async_create_entry(
                    title=hello["master"]["name"], data={CONF_HOST: host, CONF_PORT: DEFAULT_PORT}
                )
            try:  # another XP-Master, or an XP-Bridge: pair through its remote access
                self._fingerprint, device_id = await async_fetch_certificate(self.hass, host, REMOTE_PORT)
            except CannotConnect:
                errors["base"] = "cannot_connect"
            else:
                self._bridge = device_id.startswith("XPS-")
                product = "XP-Bridge" if self._bridge else "XP-Master"
                self._host, self._port, self._name = host, REMOTE_PORT, f"{product} {host}"
                return await self._pair_next()
        schema = vol.Schema({vol.Required(CONF_HOST, default=(user_input or {}).get(CONF_HOST, "")): str})
        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)

    async def async_step_pair(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """The pairing code from the XP-Master's Netroni panel (Remote Access) and its display."""
        errors: dict[str, str] = {}
        if user_input is not None:
            try:
                reply = await async_pair(
                    async_get_clientsession(self.hass), self._host, self._port, self._fingerprint,
                    self.hass.config.location_name or "Home Assistant", user_input["code"].replace(" ", ""),
                )
            except CommandError as err:
                errors["base"] = "update_xp_master" if err.code == "pake_unsupported" else "invalid_code"
            except CannotConnect:
                errors["base"] = "cannot_connect"
            else:
                return await self._paired(reply)
        return self.async_show_form(
            step_id="pair",
            data_schema=vol.Schema({vol.Required("code"): str}),
            errors=errors,
            description_placeholders={"name": self._name, "master": self._display_check()},
        )

    async def _pair_next(self) -> ConfigFlowResult:
        """An XP-Bridge pairs by its button, an XP-Master with the code from its Netroni panel."""
        return await (self.async_step_pair_button() if self._bridge else self.async_step_pair())

    async def async_step_pair_button(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """An XP-Bridge: wait for a short press on its button (it pairs the first one waiting)."""
        if self._pair_task is None:
            self._pair_task = self.hass.async_create_task(
                async_pair(async_get_clientsession(self.hass), self._host, self._port, self._fingerprint,
                           self.hass.config.location_name or "Home Assistant")
            )
        if not self._pair_task.done():
            return self.async_show_progress(
                step_id="pair_button",
                progress_action="press_button",
                progress_task=self._pair_task,
                description_placeholders={"name": self._name},
            )
        task, self._pair_task = self._pair_task, None
        try:
            self._pair_reply = task.result()
        except CommandError:
            return self.async_show_progress_done(next_step_id="button_not_pressed")
        except CannotConnect:
            return self.async_show_progress_done(next_step_id="button_cannot_connect")
        return self.async_show_progress_done(next_step_id="paired")

    async def async_step_button_not_pressed(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return await self.async_step_pair_button()
        return self.async_show_form(step_id="button_not_pressed", description_placeholders={"name": self._name})

    async def async_step_button_cannot_connect(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return await self.async_step_pair_button()
        return self.async_show_form(step_id="button_cannot_connect", description_placeholders={"name": self._name})

    async def async_step_paired(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        return await self._paired(self._pair_reply)

    async def _paired(self, reply: dict) -> ConfigFlowResult:
        data = {
            CONF_HOST: self._host, CONF_PORT: self._port,
            CONF_FINGERPRINT: self._fingerprint, CONF_TOKEN: reply["token"],
        }
        await self.async_set_unique_id(reply["master_id"])
        if self.source == SOURCE_REAUTH:
            self._abort_if_unique_id_mismatch(reason="wrong_master")
            return self.async_update_reload_and_abort(self._get_reauth_entry(), data_updates=data)
        self._abort_if_unique_id_configured(updates=data)
        return self.async_create_entry(title=self._name, data=data)

    def _display_check(self) -> str:
        """What the XP-Master's display shows while pairing (its name, serial and address), to
        check that this is the XP-Master being paired."""
        if not self._master_id:  # added by address: the address is all that is known yet
            return f"**{self._host}**"
        suffix = f" {self._master_id}"  # the discovered name is "<name> <serial>"
        name = self._name[: -len(suffix)] if self._name.endswith(suffix) else self._name
        return " · ".join(f"**{part}**" for part in (name, self._master_id, self._host) if part)

    async def async_step_reauth(self, entry_data: Mapping[str, Any]) -> ConfigFlowResult:
        """The XP-Master refused this Home Assistant (removed in its panel, or a new board)."""
        self._host, self._port = entry_data[CONF_HOST], entry_data[CONF_PORT]
        self._name = self._get_reauth_entry().title
        self._master_id = self._get_reauth_entry().unique_id or ""
        self._bridge = self._master_id.startswith("XPS-")
        try:  # a replaced XP-Master has a new certificate: compare it on its display
            self._fingerprint = await async_fetch_fingerprint(self.hass, self._host, self._port)
        except CannotConnect:
            self._fingerprint = entry_data.get(CONF_FINGERPRINT, "")
        return await self._pair_next()

    async def async_step_zeroconf(self, discovery_info: ZeroconfServiceInfo) -> ConfigFlowResult:
        master_id = discovery_info.properties.get("id")
        if not master_id:
            return self.async_abort(reason="not_netroni")
        self._host, self._port = discovery_info.host, discovery_info.port or DEFAULT_PORT
        self._name = discovery_info.name.split(".")[0]
        self._master_id = master_id
        await self.async_set_unique_id(master_id)
        local = await self._is_this_machine(master_id, self._port)
        if not local:
            return await self._discovered_remote(discovery_info)
        self._host = LOCALHOST  # this machine's own service: independent of the LAN address
        self._abort_if_unique_id_configured(updates={CONF_HOST: self._host, CONF_PORT: self._port})
        self.context["title_placeholders"] = {"name": self._name}
        if any(
            e.data.get(CONF_HOST) == LOCALHOST and e.unique_id != master_id for e in self._async_current_entries()
        ):
            # This machine's XP-Master already has an entry under another id: Home Assistant was
            # restored from a backup onto a new board. Repairs offers the restore; no second entry.
            return self.async_abort(reason="restore_pending")
        # An XP-Master's own Netroni service: add it without asking, so the Netroni panel is
        # there right after Home Assistant's first-time setup.
        return self.async_create_entry(title=self._name, data={CONF_HOST: self._host, CONF_PORT: self._port})

    async def _discovered_remote(self, discovery_info: ZeroconfServiceInfo) -> ConfigFlowResult:
        """Another XP-Master on the network: offered for pairing, if it has remote access."""
        remote_port, fingerprint = discovery_info.properties.get("remote_port"), discovery_info.properties.get("fp")
        if not remote_port or not fingerprint:
            self._abort_if_unique_id_configured()
            return self.async_abort(reason="not_local")  # a release without remote access
        # Already paired: only its address may have changed.
        self._abort_if_unique_id_configured(updates={CONF_HOST: self._host})
        self._port, self._fingerprint = int(remote_port), fingerprint
        self._bridge = discovery_info.properties.get("kind") == "stick"
        self.context["title_placeholders"] = {"name": self._name}
        return await self._pair_next()

    async def _is_this_machine(self, master_id: str, port: int) -> bool:
        """Whether the discovered XP-Master is the one on this machine: same id on 127.0.0.1.

        Compared by id, not by address: two XP-Masters on one network can share a host name, which
        mixes up the addresses that discovery reports.
        """
        try:
            hello = await self._probe(LOCALHOST, port)
        except (CannotConnect, CommandError):
            return False
        return hello.get("master", {}).get("id") == master_id

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
