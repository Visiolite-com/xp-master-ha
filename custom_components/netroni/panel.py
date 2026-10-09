"""The "Netroni" sidebar panel: installation overview and commissioning for every user.

The panel is a plain web component (frontend/netroni-panel.js, no build step). The Netroni logo
is registered as a custom icon ("netroni:logo") by frontend/netroni-icons.js, loaded on every page
so the sidebar can show it.
"""
from __future__ import annotations

from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant
from homeassistant.loader import async_get_integration

from .const import DOMAIN

URL_BASE = "/netroni_static"
PANEL_URL_PATH = "netroni"


async def async_setup_panel(hass: HomeAssistant) -> None:
    version = (await async_get_integration(hass, DOMAIN)).version  # cache-busting
    await hass.http.async_register_static_paths(
        [StaticPathConfig(URL_BASE, str(Path(__file__).parent / "frontend"), cache_headers=False)]
    )
    frontend.add_extra_js_url(hass, f"{URL_BASE}/netroni-icons.js?v={version}")
    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name="netroni-panel",
        sidebar_title="Netroni",
        sidebar_icon="netroni:logo",
        module_url=f"{URL_BASE}/netroni-panel.js?v={version}",
        require_admin=False,
        config={},
    )
