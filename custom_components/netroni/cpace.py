"""Pairing by code without sending the code: CPace (draft-irtf-cfrg-cpace-21) with ristretto255 (RFC 9496)
and SHA-512, the cipher suite CPACE-RISTR255-SHA512, initiator-responder, with key confirmation as in the
draft's section 10.4. docs/pairing.md.

The group operations run in libsodium (C, constant-time, as in the apps) wherever it is installed: the
XP-Master's image has it (its tests insist). Elsewhere, as in Home Assistant (whose PyNaCl doesn't
expose ristretto255), the pure-Python implementation below does them. Both are checked against the same
test vectors (tests/test_cpace.py).

The same file is in the Home Assistant integration (xp-master-ha custom_components/netroni/cpace.py):
keep the two identical.

Roles: the client (app, Home Assistant) is A, the initiator; the XP-Master is B. PRS is the 6-digit code.
CI binds the run to the TLS connection: it holds the SHA-256 of the server certificate as each side
sees it, so a man in the middle with a certificate of his own gives the two sides different keys and
the key confirmation fails, without the code crossing the network. One run is one guess.

The Python path is not constant-time (Python integers): every scalar is fresh for one run and thrown
away, and a run is one guess at a code that changes with every pairing window.
"""
from __future__ import annotations

import ctypes
import ctypes.util
import hashlib
import hmac
import secrets

# --- ristretto255 (RFC 9496, section 4) -------------------------------------------------------

P = 2**255 - 19
L = 2**252 + 27742317777372353535851937790883648493  # the group order
D = 37095705934669439343138083508754565189542113879843219016388785533085940283555
SQRT_M1 = 19681161376707505956807079304988542015446066515923890162744021073123829784752
SQRT_AD_MINUS_ONE = 25063068953384623474111414158702152701244531502492656460079210482610430750235
INVSQRT_A_MINUS_D = 54469307008909316920995813868745141605393597292927456921205312896311721017578
ONE_MINUS_D_SQ = 1159843021668779879193775521855586647937357759715417654439879720876111806838
D_MINUS_ONE_SQ = 40440834346308536858101042469323190826248399146238708352240133220865137265952

IDENTITY = (0, 1, 1, 0)  # extended coordinates (X, Y, Z, T)
ENCODED_IDENTITY = bytes(32)


def _is_negative(x: int) -> bool:
    return x % P & 1 == 1


def _abs(x: int) -> int:
    return (-x) % P if _is_negative(x) else x % P


def sqrt_ratio_m1(u: int, v: int) -> tuple[bool, int]:
    """RFC 9496, 4.2."""
    u, v = u % P, v % P
    r = (u * pow(v, 3, P)) * pow(u * pow(v, 7, P), (P - 5) // 8, P) % P
    check = v * r * r % P
    correct_sign_sqrt = check == u
    flipped_sign_sqrt = check == (-u) % P
    flipped_sign_sqrt_i = check == (-u * SQRT_M1) % P
    if flipped_sign_sqrt or flipped_sign_sqrt_i:
        r = SQRT_M1 * r % P
    return correct_sign_sqrt or flipped_sign_sqrt, _abs(r)


def decode(data: bytes) -> tuple[int, int, int, int] | None:
    """RFC 9496, 4.3.1; None for anything that isn't the canonical encoding of an element."""
    if len(data) != 32:
        return None
    s = int.from_bytes(data, "little")
    if s >= P or _is_negative(s):
        return None
    ss = s * s % P
    u1 = (1 - ss) % P
    u2 = (1 + ss) % P
    u2_sqr = u2 * u2 % P
    v = (-(D * u1 * u1) - u2_sqr) % P
    was_square, invsqrt = sqrt_ratio_m1(1, v * u2_sqr)
    den_x = invsqrt * u2 % P
    den_y = invsqrt * den_x * v % P
    x = _abs(2 * s * den_x)
    y = u1 * den_y % P
    t = x * y % P
    if not was_square or _is_negative(t) or y == 0:
        return None
    return x, y, 1, t


def encode(point: tuple[int, int, int, int]) -> bytes:
    """RFC 9496, 4.3.2."""
    x0, y0, z0, t0 = point
    u1 = (z0 + y0) * (z0 - y0) % P
    u2 = x0 * y0 % P
    _, invsqrt = sqrt_ratio_m1(1, u1 * u2 * u2)
    den1 = invsqrt * u1 % P
    den2 = invsqrt * u2 % P
    z_inv = den1 * den2 * t0 % P
    ix0 = x0 * SQRT_M1 % P
    iy0 = y0 * SQRT_M1 % P
    enchanted_denominator = den1 * INVSQRT_A_MINUS_D % P
    rotate = _is_negative(t0 * z_inv)
    x, y = (iy0, ix0) if rotate else (x0, y0)
    z = z0
    den_inv = enchanted_denominator if rotate else den2
    if _is_negative(x * z_inv):
        y = (-y) % P
    s = _abs(den_inv * (z - y))
    return s.to_bytes(32, "little")


def _map(b: bytes) -> tuple[int, int, int, int]:
    """RFC 9496, 4.3.4: MAP on a 32-byte string."""
    t = int.from_bytes(b, "little") % 2**255 % P
    r = SQRT_M1 * t * t % P
    u = (r + 1) * ONE_MINUS_D_SQ % P
    v = (-1 - r * D) * (r + D) % P
    was_square, s = sqrt_ratio_m1(u, v)
    s_prime = (-_abs(s * t)) % P
    s = s if was_square else s_prime
    c = (-1) % P if was_square else r
    n = (c * (r - 1) * D_MINUS_ONE_SQ - v) % P
    w0 = 2 * s * v % P
    w1 = n * SQRT_AD_MINUS_ONE % P
    w2 = (1 - s * s) % P
    w3 = (1 + s * s) % P
    return w0 * w3 % P, w2 * w1 % P, w1 * w3 % P, w0 * w2 % P


def element_derivation(b: bytes) -> tuple[int, int, int, int]:
    """RFC 9496, 4.3.4: a group element from a 64-byte string."""
    if len(b) != 64:
        raise ValueError("element derivation takes 64 bytes")
    return add(_map(b[:32]), _map(b[32:]))


def add(p1: tuple[int, int, int, int], p2: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    """Edwards addition in extended coordinates (RFC 8032, 5.1.4, a = -1)."""
    x1, y1, z1, t1 = p1
    x2, y2, z2, t2 = p2
    a = (y1 - x1) * (y2 - x2) % P
    b = (y1 + x1) * (y2 + x2) % P
    c = 2 * t1 * t2 * D % P
    d = 2 * z1 * z2 % P
    e, f, g, h = b - a, d - c, d + c, b + a
    return e * f % P, g * h % P, f * g % P, e * h % P


def scalar_mult(scalar: int, point: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    result = IDENTITY
    addend = point
    while scalar:
        if scalar & 1:
            result = add(result, addend)
        addend = add(addend, addend)
        scalar >>= 1
    return result


# --- libsodium, when there is one ----------------------------------------------------------------


def _load_sodium():
    """libsodium with its ristretto255 functions, initialised; None if there is none."""
    for name in (ctypes.util.find_library("sodium"), "libsodium.so.23", "libsodium.so.26", "libsodium.dylib"):
        if not name:
            continue
        try:
            lib = ctypes.CDLL(name)
            lib.crypto_core_ristretto255_from_hash  # noqa: B018 - a library too old to have it: not this one
            lib.crypto_scalarmult_ristretto255  # noqa: B018
        except (OSError, AttributeError):
            continue
        if lib.sodium_init() < 0:
            continue
        return lib
    return None


_sodium = _load_sodium()
BACKEND = "libsodium" if _sodium is not None else "python"


def generator(hash64: bytes, backend: str = BACKEND) -> bytes:
    """The encoded element derived from a 64-byte hash (RFC 9496, 4.3.4)."""
    if backend == "libsodium":
        out = ctypes.create_string_buffer(32)
        _sodium.crypto_core_ristretto255_from_hash(out, hash64)
        return out.raw
    return encode(element_derivation(hash64))


def multiply(y: int, encoded: bytes, backend: str = BACKEND) -> bytes:
    """y times an encoded element, encoded; the encoded identity when it doesn't decode or the result is
    the identity (then the caller must abort): CPace's scalar_mult_vfy, and scalar_mult too."""
    if backend == "libsodium":
        if len(encoded) != 32:
            return ENCODED_IDENTITY
        out = ctypes.create_string_buffer(32)
        # It clears bit 255 of the scalar and nothing else: ours are below 2^252, used as they are.
        if _sodium.crypto_scalarmult_ristretto255(out, y.to_bytes(32, "little"), encoded) != 0:
            return ENCODED_IDENTITY
        return out.raw
    return scalar_mult_vfy(y, encoded)


# --- CPace (draft-irtf-cfrg-cpace-21) ----------------------------------------------------------

DSI = b"CPaceRistretto255"
S_IN_BYTES = 128  # SHA-512's input block size
CHANNEL = b"netroni-pair-v1"  # this application's part of CI


def prepend_len(data: bytes) -> bytes:
    """LEB128 length, then the data (draft A.1.1)."""
    length, encoded = len(data), b""
    while True:
        encoded += bytes([length]) if length < 128 else bytes([(length & 0x7F) + 0x80])
        length >>= 7
        if length == 0:
            return encoded + data


def lv_cat(*args: bytes) -> bytes:
    return b"".join(prepend_len(a) for a in args)


def generator_string(dsi: bytes, prs: bytes, ci: bytes, sid: bytes, s_in_bytes: int = S_IN_BYTES) -> bytes:
    len_zpad = max(0, s_in_bytes - 1 - len(prepend_len(prs)) - len(prepend_len(dsi)))
    return lv_cat(dsi, prs, bytes(len_zpad), ci, sid)


def calculate_generator(prs: bytes, ci: bytes, sid: bytes, backend: str = BACKEND) -> bytes:
    """The generator, encoded."""
    return generator(hashlib.sha512(generator_string(DSI, prs, ci, sid)).digest(), backend)


def sample_scalar() -> int:
    """32 random bytes with the bits above the group's 252 cleared, little-endian (draft 8.3)."""
    while True:
        y = int.from_bytes(bytearray(secrets.token_bytes(31)) + bytes([secrets.randbelow(16)]), "little")
        if y:
            return y


def scalar_mult_vfy(y: int, encoded: bytes) -> bytes:
    """y times a received element; the encoded identity when it doesn't decode or the result is the
    identity (the caller must then abort)."""
    point = decode(encoded)
    if point is None:
        return ENCODED_IDENTITY
    return encode(scalar_mult(y, point))


def transcript_ir(ya: bytes, ada: bytes, yb: bytes, adb: bytes) -> bytes:
    return lv_cat(ya, ada) + lv_cat(yb, adb)


def isk(sid: bytes, k: bytes, ya: bytes, ada: bytes, yb: bytes, adb: bytes) -> bytes:
    return hashlib.sha512(lv_cat(DSI + b"_ISK", sid, k) + transcript_ir(ya, ada, yb, adb)).digest()


def mac_key(sid: bytes, isk_value: bytes) -> bytes:
    return hashlib.sha512(b"CPaceMac" + sid + isk_value).digest()


def tag(key: bytes, share: bytes, ad: bytes) -> bytes:
    """The key-confirmation tag over a party's own message (draft 10.4)."""
    return hmac.new(key, lv_cat(share, ad), hashlib.sha512).digest()


def channel(fingerprint: bytes) -> bytes:
    """CI: this application, and the server certificate's SHA-256 as this side sees it."""
    if len(fingerprint) != 32:
        raise ValueError("the certificate fingerprint is 32 bytes (SHA-256)")
    return lv_cat(CHANNEL, fingerprint)


class CPaceError(Exception):
    """An invalid share (abort), or a confirmation tag that doesn't match (wrong code, or another
    certificate in between)."""


class Initiator:
    """The client's side: start(), then finish() with the server's reply."""

    def __init__(self, code: str, fingerprint: bytes, ada: bytes, sid: bytes | None = None, y: int | None = None,
                 backend: str = BACKEND) -> None:
        self.sid = sid if sid is not None else secrets.token_bytes(16)
        self.ci = channel(fingerprint)
        self.prs = code.encode()
        self.ada = ada
        self.backend = backend
        self._y = y if y is not None else sample_scalar()
        self.share = multiply(self._y, calculate_generator(self.prs, self.ci, self.sid, backend), backend)

    def finish(self, yb: bytes, adb: bytes, server_tag: bytes) -> bytes:
        """The server's share and tag: our tag to send. Raises CPaceError if the server's tag is wrong
        (wrong code, or the certificate isn't the one the server has)."""
        k = multiply(self._y, yb, self.backend)
        self._y = 0
        if k == ENCODED_IDENTITY:
            raise CPaceError("invalid share from the server")
        key = mac_key(self.sid, isk(self.sid, k, self.share, self.ada, yb, adb))
        if not hmac.compare_digest(server_tag, tag(key, yb, adb)):
            raise CPaceError("the server could not confirm the code")
        return tag(key, self.share, self.ada)


class Responder:
    """The server's side: the client's share in, our share and tag out; then check the client's tag."""

    def __init__(self, code: str, fingerprint: bytes, sid: bytes, ya: bytes, ada: bytes, adb: bytes,
                 y: int | None = None, backend: str = BACKEND) -> None:
        if not 8 <= len(sid) <= 64:
            raise CPaceError("sid must be 8 to 64 bytes")
        ci = channel(fingerprint)
        yb_scalar = y if y is not None else sample_scalar()
        self.share = multiply(yb_scalar, calculate_generator(code.encode(), ci, sid, backend), backend)
        self.adb = adb
        k = multiply(yb_scalar, ya, backend)
        if k == ENCODED_IDENTITY:
            raise CPaceError("invalid share from the client")
        key = mac_key(sid, isk(sid, k, ya, ada, self.share, adb))
        self.tag = tag(key, self.share, adb)
        self._expected = tag(key, ya, ada)

    def check(self, client_tag: bytes) -> bool:
        return hmac.compare_digest(client_tag, self._expected)
