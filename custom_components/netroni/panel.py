"""The "Netroni" sidebar panel: installation overview and commissioning for every user.

The panel is a plain web component (frontend/netroni-panel.js, no build step). The Netroni logo
is registered as a custom icon ("netroni:logo") by frontend/netroni-icons.js, loaded on every page
so the sidebar can show it.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

URL_BASE = "/netroni_static"
PANEL_URL_PATH = "netroni"


FRONTEND = Path(__file__).parent / "frontend"


def _stamp(name: str) -> str:
    """Cache-busting: changes whenever the file does, so browsers never keep an old panel."""
    return hashlib.sha256((FRONTEND / name).read_bytes()).hexdigest()[:12]


async def async_setup_panel(hass: HomeAssistant) -> None:
    icons, panel = await hass.async_add_executor_job(lambda: (_stamp("netroni-icons.js"), _stamp("netroni-panel.js")))
    await hass.http.async_register_static_paths(
        [StaticPathConfig(URL_BASE, str(FRONTEND), cache_headers=False)]
    )
    frontend.add_extra_js_url(hass, f"{URL_BASE}/netroni-icons.js?v={icons}")
    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name="netroni-panel",
        sidebar_title="Netroni",
        sidebar_icon="netroni:logo",
        module_url=f"{URL_BASE}/netroni-panel.js?v={panel}",
        require_admin=False,
        config={},
    )
