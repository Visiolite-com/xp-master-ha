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
BUTTON_TIMEOUT = 100  # s pairing by the button may take: the XP-Bridge waits 90 s for the press


def _pinned(fingerprint: str) -> aiohttp.Fingerprint:
    return aiohttp.Fingerprint(bytes.fromhex(fingerprint.replace(":", "")))


async def async_entry_token(hass, data: dict) -> str | None:
    """A remote XP-Master: the token from the pairing; this machine's: the token file."""
    from .const import CONF_TOKEN

    return data.get(CONF_TOKEN) or await async_read_token(hass)


def client_for_entry(hass, data: dict, **kwargs) -> NetroniClient:
    from homeassistant.helpers.aiohttp_client import async_get_clientsession

    from .const import CONF_FINGERPRINT

    return NetroniClient(
        async_get_clientsession(hass), data["host"], data["port"], fingerprint=data.get(CONF_FINGERPRINT), **kwargs
    )


async def async_fetch_fingerprint(hass, host: str, port: int) -> str:
    """The certificate an XP-Master's remote access shows, as hex (trust on first use: the person
    pairing compares its start with the XP-Master's display). Raises CannotConnect."""
    return (await async_fetch_certificate(hass, host, port))[0]


async def async_fetch_certificate(hass, host: str, port: int) -> tuple[str, str]:
    """(fingerprint as hex, the id in its name): "Netroni XPM-…" for an XP-Master, "Netroni XPS-…"
    for an XP-Bridge, which pairs by its button instead of a code. Raises CannotConnect."""
    import hashlib
    import ssl

    from cryptography import x509
    from cryptography.x509.oid import NameOID

    def fetch() -> tuple[str, str]:
        der = ssl.PEM_cert_to_DER_cert(ssl.get_server_certificate((host, port), timeout=CALL_TIMEOUT))
        names = x509.load_der_x509_certificate(der).subject.get_attributes_for_oid(NameOID.COMMON_NAME)
        name = str(names[0].value) if names else ""
        return hashlib.sha256(der).hexdigest(), name.removeprefix("Netroni ").strip()

    try:
        return await hass.async_add_executor_job(fetch)
    except (OSError, ssl.SSLError, ValueError) as err:
        raise CannotConnect(f"no remote access on {host}:{port}: {err}") from err


async def async_pair(
    session: aiohttp.ClientSession, host: str, port: int, fingerprint: str, name: str, code: str | None = None
) -> dict:
    """Pair with an XP-Master's remote access: {"token", "client_id", "master_id"}. Without a code:
    pairing by an XP-Bridge's button; this waits for the press (the XP-Bridge first answers
    "pair_waiting"). Raises CommandError("pair_invalid") for a wrong code, no open window or no
    press in time, CannotConnect otherwise."""
    url = f"wss://{host}:{port}{WS_PATH}"
    request = {"type": "pair", "name": name, **({"code": code} if code is not None else {"button": True})}
    try:
        async with asyncio.timeout(CALL_TIMEOUT if code is not None else BUTTON_TIMEOUT):
            async with session.ws_connect(url, ssl=_pinned(fingerprint)) as ws:
                await ws.send_json(request)
                msg = await ws.receive()
                while msg.type is aiohttp.WSMsgType.TEXT and json.loads(msg.data).get("type") == "pair_waiting":
                    msg = await ws.receive()
    except aiohttp.ServerFingerprintMismatch as err:
        raise CannotConnect(f"{url} has another certificate") from err
    except (aiohttp.ClientError, TimeoutError, OSError) as err:
        raise CannotConnect(f"cannot connect to {url}: {err}") from err
    reply = json.loads(msg.data) if msg.type is aiohttp.WSMsgType.TEXT else {}
    if reply.get("type") == "pair_ok":
        return reply
    raise CommandError("pair_invalid", reply.get("message", "pairing refused"))


async def async_read_token(hass) -> str | None:
    """The Netroni service's API token (TOKEN_FILE), if this machine has one."""
    from .const import TOKEN_FILE

    def read() -> str | None:
        try:
            return open(TOKEN_FILE, encoding="utf-8").read().strip() or None
        except OSError:
            return None

    return await hass.async_add_executor_job(read)


class NetroniError(Exception):
    """Base error."""


class CannotConnect(NetroniError):
    """The Master could not be reached or the connection dropped."""


class AuthFailed(CannotConnect):
    """The Master refused this client's token (remote access: not paired, or removed)."""


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
        token: str | None = None,
        fingerprint: str | None = None,
    ) -> None:
        # Remote access: TLS, with the XP-Master's certificate pinned by its SHA-256 fingerprint.
        self._ssl = _pinned(fingerprint) if fingerprint else None
        self.url = f"{'wss' if fingerprint else 'ws'}://{host}:{port}{WS_PATH}"
        self.token = token  # sent first on every connection (the service refuses clients without it)
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
                self._ws = await self._session.ws_connect(self.url, heartbeat=30, ssl=self._ssl)
                if self.token:
                    await self._authenticate(self._ws)
        except aiohttp.ServerFingerprintMismatch as err:
            raise AuthFailed(f"{self.url} has another certificate than the one paired") from err
        except (aiohttp.ClientError, TimeoutError, OSError) as err:
            raise CannotConnect(f"cannot connect to {self.url}: {err}") from err
        self._reader = asyncio.create_task(self._read_loop(self._ws))

    async def _authenticate(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        await ws.send_json({"type": "auth", "token": self.token})
        msg = await ws.receive()
        reply = json.loads(msg.data) if msg.type is aiohttp.WSMsgType.TEXT else {}
        if reply.get("type") != "auth_ok":  # auth_invalid, or the connection closed
            await ws.close()
            self._ws = None
            raise AuthFailed(f"{self.url} refused the API token")

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
