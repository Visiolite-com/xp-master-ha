"""Home Assistant backups carry the XP-Master's own settings.

Before every backup (automatic or manual) the Netroni service's configuration and light states
are written to <config>/netroni/<master id>.json, so the backup has them. After Home Assistant was
restored onto a new or re-flashed XP-Master, the integration finds that file newer than what the
service has (or from another XP-Master id) and offers to restore it (Repairs, see repairs.py).
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path

from homeassistant.core import HomeAssistant
from homeassistant.helpers import issue_registry as ir

from .client import NetroniError
from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

RESTORE_ISSUE = "restore_"  # Repairs issue id prefix, followed by the config entry id


def backup_path(hass: HomeAssistant, master_id: str) -> Path:
    return Path(hass.config.path("netroni")) / f"{master_id}.json"


async def async_pre_backup(hass: HomeAssistant) -> None:
    """Save each XP-Master's settings into Home Assistant's config folder, for the backup."""
    for entry in hass.config_entries.async_loaded_entries(DOMAIN):
        hub = entry.runtime_data
        try:
            backup = await hub.client.call("backup/export")
        except NetroniError as err:  # never fail Home Assistant's backup for it
            _LOGGER.warning("XP-Master %s settings not in this backup: %s", hub.master_id, err)
            continue
        path = backup_path(hass, entry.unique_id or hub.master_id)
        await hass.async_add_executor_job(_write, path, backup)
        _LOGGER.info("XP-Master %s settings saved for the backup (version %s)", hub.master_id,
                     backup.get("config", {}).get("version"))


async def async_post_backup(hass: HomeAssistant) -> None:
    """Nothing to undo: the file stays, it is the latest backed-up state."""


def _write(path: Path, data: dict) -> None:
    path.parent.mkdir(exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    os.replace(tmp, path)


def _read(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and data.get("format") == 1 else None


async def async_read_backup(hass: HomeAssistant, master_id: str) -> dict | None:
    return await hass.async_add_executor_job(_read, backup_path(hass, master_id))


async def async_check_restore(hass: HomeAssistant, entry, master_id: str, config_version: int) -> tuple[bool, bool]:
    """Offer a restore when the saved settings are newer than the service's, or from the XP-Master
    this entry was made for while the service now has another id (a new board).

    Returns (other, offered). other: the service is another XP-Master than this entry's, so the
    entry must not be set up (it would replace the devices and entities with new ones). offered:
    a restore is offered, so entities the current settings lack must be kept until it is done."""
    other = bool(entry.unique_id) and master_id != entry.unique_id
    backup = await async_read_backup(hass, entry.unique_id or master_id)
    version = (backup or {}).get("config", {}).get("version", 0)
    issue_id = RESTORE_ISSUE + entry.entry_id
    offered = backup is not None and (other or version > config_version)
    if offered:
        ir.async_create_issue(
            hass,
            DOMAIN,
            issue_id,
            is_fixable=True,
            is_persistent=False,
            severity=ir.IssueSeverity.WARNING,
            translation_key="restore",
            translation_placeholders={
                "name": entry.title,
                "minis": str(len(backup["config"].get("minis", []))),
                "version": str(version),
                "current": str(config_version),
            },
            data={"kind": "restore", "entry_id": entry.entry_id},
        )
    elif other:
        ir.async_create_issue(
            hass,
            DOMAIN,
            issue_id,
            is_fixable=False,
            is_persistent=False,
            severity=ir.IssueSeverity.ERROR,
            translation_key="other_master",
            translation_placeholders={"name": entry.title, "old": entry.unique_id, "new": master_id},
        )
    else:
        ir.async_delete_issue(hass, DOMAIN, issue_id)
    return other, offered
