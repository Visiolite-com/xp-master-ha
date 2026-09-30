"""WebSocket client for the Netroni service API (v0).

Bundled for now; to be split out into a PyPI library before any submission to Home Assistant core.
"""
from __future__ import annotations

import asyncio
import itertools
import json
import logging
from collections.abc import Callable
from typing import Any

import aiohttp

_LOGGER = logging.getLogger(__name__)

WS_PATH = "/api/ws"
CALL_TIMEOUT = 10


class NetroniError(Exception):
    """Base error."""


class CannotConnect(NetroniError):
    """The Master could not be reached or the connection dropped."""


class CommandError(NetroniError):
    """The Master rejected a command."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


class NetroniClient:
    def __init__(
        self,
        session: aiohttp.ClientSession,
        host: str,
        port: int,
        on_event: Callable[[str, dict], None] | None = None,
        on_disconnect: Callable[[], None] | None = None,
    ) -> None:
        self.url = f"ws://{host}:{port}{WS_PATH}"
        self._session = session
        self._on_event = on_event
        self._on_disconnect = on_disconnect
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._reader: asyncio.Task | None = None
        self._ids = itertools.count(1)
        self._pending: dict[int, asyncio.Future[dict]] = {}
        self._closing = False

    @property
    def connected(self) -> bool:
        return self._ws is not None and not self._ws.closed

    async def connect(self) -> None:
        self._closing = False
        try:
            async with asyncio.timeout(CALL_TIMEOUT):
                self._ws = await self._session.ws_connect(self.url, heartbeat=30)
        except (aiohttp.ClientError, TimeoutError, OSError) as err:
            raise CannotConnect(f"cannot connect to {self.url}: {err}") from err
        self._reader = asyncio.create_task(self._read_loop(self._ws))

    async def close(self) -> None:
        """Close on purpose: on_disconnect is not called. connect() may be called again."""
        self._closing = True
        if self._ws is not None:
            await self._ws.close()
        if self._reader is not None:
            await asyncio.gather(self._reader, return_exceptions=True)

    async def call(self, msg_type: str, **fields: Any) -> dict:
        if not self.connected:
            raise CannotConnect("not connected")
        msg_id = next(self._ids)
        future: asyncio.Future[dict] = asyncio.get_running_loop().create_future()
        self._pending[msg_id] = future
        try:
            await self._ws.send_json({"id": msg_id, "type": msg_type, **fields})
            async with asyncio.timeout(CALL_TIMEOUT):
                reply = await future
        except (aiohttp.ClientError, ConnectionError) as err:
            raise CannotConnect(str(err)) from err
        except TimeoutError as err:
            raise CannotConnect(f"{msg_type} timed out") from err
        finally:
            self._pending.pop(msg_id, None)
        if not reply.get("success"):
            error = reply.get("error", {})
            raise CommandError(error.get("code", "unknown"), error.get("message", ""))
        return reply.get("result", {})

    async def _read_loop(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        try:
            async for msg in ws:
                if msg.type is not aiohttp.WSMsgType.TEXT:
                    continue
                try:
                    data = json.loads(msg.data)
                except ValueError:
                    _LOGGER.warning("ignoring non-JSON message from %s", self.url)
                    continue
                if data.get("type") == "event":
                    if self._on_event:
                        self._on_event(data.get("event", ""), data.get("data", {}))
                    continue
                future = self._pending.get(data.get("id"))
                if future and not future.done():
                    future.set_result(data)
        finally:
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(CannotConnect("connection closed"))
            if self._on_disconnect and not self._closing:
                self._on_disconnect()
