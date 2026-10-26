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
from .const import DEFAULT_PORT, DOMAIN, PORTS_PER_MINI

LOCALHOST = "127.0.0.1"  # Home Assistant and the Netroni service share the host network
from .matter import async_open_window, paired_apps_text, qr_placeholders
from .replace import async_replace, replace_summary


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
        local = await self._is_this_machine(master_id, self._port)
        if local:
            self._host = LOCALHOST  # this machine's own service: independent of the LAN address
        self._abort_if_unique_id_configured(updates={CONF_HOST: self._host, CONF_PORT: self._port})
        self.context["title_placeholders"] = {"name": self._name}
        if local:
            # An XP-Master's own Netroni service: add it without asking, so the Netroni panel is
            # there right after Home Assistant's first-time setup.
            return self.async_create_entry(title=self._name, data={CONF_HOST: self._host, CONF_PORT: self._port})
        return await self.async_step_zeroconf_confirm()

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


class NetroniOptionsFlow(OptionsFlow):
    """Configure: tunable-white ports per XP-Mini, and pairing with Matter apps."""

    def __init__(self) -> None:
        self._uid = ""
        self._new = ""
        self._pair: list[int] = []
        self._unpair: list[int] = []

    @property
    def _hub(self):
        return self.config_entry.runtime_data

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if self.config_entry.state is not ConfigEntryState.LOADED:
            return self.async_abort(reason="not_loaded")
        return self.async_show_menu(
            step_id="init", menu_options=["tunable_white", "matter", "restart", "replace", "factory_reset", "updates"]
        )

    # --- XP-Master updates: stable or beta releases ---

    async def async_step_updates(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        status = self._hub.update_status
        if not status:
            return self.async_abort(reason="updates_unsupported")
        if user_input is not None:
            channel = "beta" if user_input["beta"] else "stable"
            try:
                self._hub.update_status = await self._hub.client.call("update/set_channel", channel=channel)
                if channel != status.get("channel"):
                    self._hub.update_status = await self._hub.client.call("update/check")
            except NetroniError as err:
                return self.async_abort(reason="set_failed", description_placeholders={"error": str(err)})
            return self.async_abort(reason=f"updates_{channel}")
        return self.async_show_form(
            step_id="updates",
            data_schema=vol.Schema({vol.Required("beta", default=status.get("channel") == "beta"): bool}),
            description_placeholders={"installed": status.get("installed") or "unknown"},
        )

    # Home Assistant dialogs have no back button: "Back" is a menu entry that returns to "init".

    # --- Matter connections: SmartThings, Google Home, Alexa, Apple Home ---

    async def async_step_matter(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        try:
            status = await self._hub.client.call("matter/status")
        except NetroniError as err:
            return self.async_abort(reason="matter_failed", description_placeholders={"error": str(err)})
        if not status.get("connected"):
            return self.async_abort(reason="matter_starting" if status.get("starting") else "matter_unavailable")
        paired = bool(status.get("commissioned") and status.get("fabrics"))
        return self.async_show_menu(
            step_id="matter",
            menu_options={
                "matter_open_window": "Pair another app" if paired else "Pair an app",
                "init": "Back",
            },
            description_placeholders={"apps": paired_apps_text(status) if paired else "- No app yet"},
        )

    async def async_step_matter_open_window(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        try:
            status = await async_open_window(self._hub)
        except NetroniError as err:
            return self.async_abort(reason="matter_failed", description_placeholders={"error": str(err)})
        return self.async_show_form(
            step_id="matter_qr",
            data_schema=vol.Schema({}),
            description_placeholders=await self.hass.async_add_executor_job(qr_placeholders, status),
        )

    async def async_step_matter_qr(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        # "Done": end the dialog. Home Assistant always shows a final screen; an abort gives a
        # useful message and a Close button instead of "Options successfully saved".
        return self.async_abort(reason="matter_done")

    # --- Configure ports ---

    async def async_step_tunable_white(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        options = {
            f"mini_{index}": f"{mini['name']} ({mini['uid']}) · "
            + (_pairs_text(mini["pairs"]) if mini.get("online", True) else "offline")
            for index, mini in enumerate(self._hub.config.get("minis", []))
        }
        options["init"] = "Back"
        return self.async_show_menu(step_id="tunable_white", menu_options=options)

    def __getattr__(self, name: str):
        """Menu entries mini_0, mini_1, ... of "Configure ports" and reset_0, ... of "Factory reset":
        one step per XP-Mini."""
        for prefix, next_step in (
            ("async_step_mini_", "async_step_ports"),
            ("async_step_restart_", "async_step_restart_now"),
            ("async_step_reset_", "async_step_reset_confirm"),
        ):
            if name.startswith(prefix) and name[len(prefix):].isdigit():
                index = int(name[len(prefix):])

                async def step(user_input: dict[str, Any] | None = None, index=index, next_step=next_step) -> ConfigFlowResult:
                    minis = self._hub.config.get("minis", [])
                    if index >= len(minis):
                        return self.async_abort(reason="mini_gone")
                    self._uid = minis[index]["uid"]
                    return await getattr(self, next_step)()

                return step
        raise AttributeError(name)

    # --- Replace an XP-Mini ---

    async def async_step_replace(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        minis = self._hub.config.get("minis", [])
        offline = [m for m in minis if not m.get("online", True)]
        online = [m for m in minis if m.get("online", True)]
        if not offline:
            return self.async_abort(reason="nothing_to_replace")
        if not online:
            return self.async_abort(reason="no_online_minis")
        if user_input is not None:
            self._uid, self._new = user_input["old"], user_input["new"]
            return await self.async_step_replace_confirm()
        # New units found while another was offline first: they are the likely replacements.
        online.sort(key=lambda m: not m.get("replace_candidate"))
        schema = vol.Schema(
            {
                vol.Required("old"): SelectSelector(
                    SelectSelectorConfig(
                        options=[SelectOptionDict(value=m["uid"], label=f"{m['name']} ({m['uid']})") for m in offline],
                        mode=SelectSelectorMode.LIST,
                    )
                ),
                vol.Required("new", default=online[0]["uid"]): SelectSelector(
                    SelectSelectorConfig(
                        options=[
                            SelectOptionDict(
                                value=m["uid"],
                                label=f"{m['name']} ({m.get('hardware_uid') or m['uid']})"
                                + (" · new" if m.get("replace_candidate") else ""),
                            )
                            for m in online
                        ],
                        mode=SelectSelectorMode.DROPDOWN,
                    )
                ),
            }
        )
        return self.async_show_form(step_id="replace", data_schema=schema)

    async def async_step_replace_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        old, new = self._hub.mini(self._uid), self._hub.mini(self._new)
        if old is None or new is None:
            return self.async_abort(reason="mini_gone")
        if user_input is not None:
            try:
                await async_replace(self._hub, self._uid, self._new)
            except NetroniError as err:
                return self.async_abort(reason="replace_failed", description_placeholders={"error": str(err)})
            return self.async_abort(reason="replace_done", description_placeholders={"old": old["name"]})
        return self.async_show_form(
            step_id="replace_confirm", data_schema=vol.Schema({}), description_placeholders=replace_summary(self._hub, old, new)
        )

    # --- Restart (as the XP-Mini's Restart button: it keeps everything, so no confirmation) ---

    async def async_step_restart(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        options = {
            f"restart_{index}": f"{mini['name']} ({mini['uid']})"
            for index, mini in enumerate(self._hub.config.get("minis", []))
            if mini.get("online", True)
        }
        if not options:
            return self.async_abort(reason="no_online_minis")
        options["init"] = "Back"
        return self.async_show_menu(step_id="restart", menu_options=options)

    async def async_step_restart_now(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        mini = self._hub.mini(self._uid)
        if mini is None:
            return self.async_abort(reason="mini_gone")
        try:
            await self._hub.client.call("mini/restart", uid=self._uid)
        except NetroniError as err:
            return self.async_abort(reason="restart_failed", description_placeholders={"error": str(err)})
        return self.async_abort(reason="restart_done", description_placeholders={"mini": mini["name"]})

    # --- Factory reset ---

    async def async_step_factory_reset(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        options = {
            f"reset_{index}": f"{mini['name']} ({mini['uid']})"
            for index, mini in enumerate(self._hub.config.get("minis", []))
            if mini.get("online", True)
        }
        if not options:
            return self.async_abort(reason="no_online_minis")
        options["init"] = "Back"
        return self.async_show_menu(step_id="factory_reset", menu_options=options)

    async def async_step_reset_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        mini = self._hub.mini(self._uid)
        if mini is None:
            return self.async_abort(reason="mini_gone")
        if user_input is not None:
            try:
                result = await self._hub.client.call("mini/factory_reset", uid=self._uid)
            except NetroniError as err:
                return self.async_abort(reason="reset_failed", description_placeholders={"error": str(err)})
            if result.get("found_again"):
                return self.async_abort(
                    reason="reset_done", description_placeholders={"mini": mini["name"], "dmx": str(result["dmx_start"])}
                )
            return self.async_abort(reason="reset_done_gone", description_placeholders={"mini": mini["name"]})
        return self.async_show_form(
            step_id="reset_confirm",
            data_schema=vol.Schema({}),
            description_placeholders={"mini": mini["name"], "uid": self._uid},
        )

    async def async_step_ports(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
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
            SelectOptionDict(value=str(p), label=f"Port {p}A + Port {p}B → Port {p}T")
            for p in range(1, PORTS_PER_MINI + 1)
        ]
        schema = vol.Schema(
            {
                vol.Optional("paired", default=[str(c) for c in sorted(current)]): SelectSelector(
                    SelectSelectorConfig(options=options, multiple=True, mode=SelectSelectorMode.LIST)
                )
            }
        )
        return self.async_show_form(
            step_id="ports", data_schema=schema, description_placeholders={"mini": mini["name"]}
        )

    async def async_step_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        mini = self._hub.mini(self._uid)
        if mini is None:
            return self.async_abort(reason="mini_gone")
        if user_input is not None:
            # One call for the whole change: the Master applies it at once and announces one
            # configuration change.
            wanted = sorted((set(mini["pairs"]) | set(self._pair)) - set(self._unpair))
            try:
                await self._hub.client.call("mini/set_pairs", uid=self._uid, pairs=wanted)
            except NetroniError as err:
                return self.async_abort(reason="set_failed", description_placeholders={"error": str(err)})
            return self.async_create_entry(data=dict(self.config_entry.options))
        changes = [f"Port {p}A + Port {p}B become Port {p}T" for p in self._pair]
        changes += [f"Port {p}T becomes Port {p}A and Port {p}B" for p in self._unpair]
        return self.async_show_form(
            step_id="confirm",
            data_schema=vol.Schema({}),
            description_placeholders={"mini": mini["name"], "changes": "\n".join(f"- {c}" for c in changes)},
        )


def _pairs_text(pairs: list[int]) -> str:
    return "tunable white: " + ", ".join(f"Port {p}T" for p in pairs) if pairs else "no tunable-white ports"
