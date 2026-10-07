"""Reverse port identification: a device on an XP-Mini port signalled its identity.

The installer gets a persistent notification naming the XP-Mini and port, with a link that
opens the light so it can be renamed on the spot. The notification is removed once one of
its lights has been renamed; repeat signals from the same port replace it.
"""
from __future__ import annotations

from homeassistant.components import persistent_notification
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.util import dt as dt_util

from .const import DOMAIN
from .hub import NetroniHub


def port_label(data: dict) -> str:
    """'Port 3B', or 'Port 3' when the signal covers the whole port."""
    return f"Port {data['port']}{(data.get('side') or '').upper()}"


@callback
def async_notify_port_identified(hass: HomeAssistant, hub: NetroniHub, data: dict) -> None:
    ent_reg = er.async_get(hass)
    device = dr.async_get(hass).async_get_device(identifiers={(DOMAIN, data["uid"])})
    mini = hub.mini(data["uid"]) or {}
    area = ar.async_get(hass).async_get_area(device.area_id) if device and device.area_id else None

    where = f"**{mini.get('name', data['uid'])}**"
    if area:
        where += f" ({area.name})"
    lines = [f"{where} · **{port_label(data)}** · {dt_util.now().strftime('%H:%M:%S')}", ""]

    entity_ids: set[str] = set()
    for light_id in data.get("light_ids", []):
        light = hub.light(light_id) or {}
        entity_id = ent_reg.async_get_entity_id("light", DOMAIN, f"{hub.master_id}_{light_id}")
        if entity_id is None:
            continue
        entity_ids.add(entity_id)
        entry = ent_reg.async_get(entity_id)
        current = (entry.name if entry else None) or light.get("name") or light.get("default_name", light_id)
        # Opens the light's settings (Name field first) on its XP-Mini's device page.
        target = (
            f"/config/devices/device/{device.id}?more-info-entity-id={entity_id}&more-info-view=settings"
            if device
            else ""
        )
        lines.append(f"- {current}: [Name this light]({target})" if target else f"- {current}")

    notification_id = f"{DOMAIN}_identify_{data['uid']}_{data['port']}{data.get('side') or ''}"
    persistent_notification.async_create(
        hass,
        "\n".join(lines),
        title=f"{port_label(data)} identified itself",
        notification_id=notification_id,
    )
    hub.identify_notifications[notification_id] = entity_ids


@callback
def async_dismiss_for_entity(hass: HomeAssistant, hub: NetroniHub, entity_id: str) -> None:
    """A light was renamed: its identification notification has done its job."""
    for notification_id, entity_ids in list(hub.identify_notifications.items()):
        if entity_id in entity_ids:
            persistent_notification.async_dismiss(hass, notification_id)
            del hub.identify_notifications[notification_id]
