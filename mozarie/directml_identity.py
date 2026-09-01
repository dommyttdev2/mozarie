from __future__ import annotations

import ctypes
import os


_KMTQAITYPE_PHYSICALADAPTERCOUNT = 30
_KMTQAITYPE_PHYSICALADAPTERPNPKEY = 41
_D3DKMT_PNP_KEY_HARDWARE = 1
_D3DKMT_PNP_KEY_SOFTWARE = 2

PhysicalAdapterIdentity = frozenset[tuple[str, str]]


class _Luid(ctypes.Structure):
    _fields_ = [("LowPart", ctypes.c_uint32), ("HighPart", ctypes.c_int32)]


class _OpenAdapterFromLuid(ctypes.Structure):
    _fields_ = [("AdapterLuid", _Luid), ("hAdapter", ctypes.c_uint32)]


class _CloseAdapter(ctypes.Structure):
    _fields_ = [("hAdapter", ctypes.c_uint32)]


class _QueryAdapterInfo(ctypes.Structure):
    _fields_ = [
        ("hAdapter", ctypes.c_uint32),
        ("Type", ctypes.c_int),
        ("pPrivateDriverData", ctypes.c_void_p),
        ("PrivateDriverDataSize", ctypes.c_uint32),
    ]


class _PhysicalAdapterCount(ctypes.Structure):
    _fields_ = [("Count", ctypes.c_uint32)]


class _QueryPhysicalAdapterPnpKey(ctypes.Structure):
    _fields_ = [
        ("PhysicalAdapterIndex", ctypes.c_uint32),
        ("PnPKeyType", ctypes.c_int),
        ("pDest", ctypes.POINTER(ctypes.c_wchar)),
        ("pCchDest", ctypes.POINTER(ctypes.c_uint32)),
    ]


def _query_adapter_info(gdi32: object, handle: int, query_type: int, payload: object) -> int:
    query = _QueryAdapterInfo(
        handle,
        query_type,
        ctypes.cast(ctypes.pointer(payload), ctypes.c_void_p),
        ctypes.sizeof(payload),
    )
    return int(gdi32.D3DKMTQueryAdapterInfo(ctypes.byref(query)))


def _physical_adapter_count(gdi32: object, handle: int) -> int | None:
    payload = _PhysicalAdapterCount()
    status = _query_adapter_info(gdi32, handle, _KMTQAITYPE_PHYSICALADAPTERCOUNT, payload)
    if status < 0 or payload.Count <= 0:
        return None
    return int(payload.Count)


def _query_pnp_key(
    gdi32: object,
    handle: int,
    physical_index: int,
    key_type: int,
) -> str | None:
    buffer = ctypes.create_unicode_buffer(1024)
    chars = ctypes.c_uint32(len(buffer))
    payload = _QueryPhysicalAdapterPnpKey(
        physical_index,
        key_type,
        ctypes.cast(buffer, ctypes.POINTER(ctypes.c_wchar)),
        ctypes.pointer(chars),
    )
    status = _query_adapter_info(gdi32, handle, _KMTQAITYPE_PHYSICALADAPTERPNPKEY, payload)
    if status < 0 or not buffer.value:
        return None
    return buffer.value.casefold()


def physical_adapter_identity(luid: tuple[int, int]) -> PhysicalAdapterIdentity | None:  # pragma: no cover
    """Resolve a DXGI AdapterLuid to its complete Windows physical PnP identity.

    D3DKMTOpenAdapterFromLuid accepts the DXGI LUID. The physical-adapter count
    then defines the complete set of physical adapters represented by that
    logical adapter, and KMTQAITYPE_PHYSICALADAPTERPNPKEY exposes each member's
    hardware and driver PnP keys. Every key for every reported physical adapter
    must be available and unique. Any API failure returns no identity so callers
    fail closed rather than infer an adapter from its numeric index.
    """
    if os.name != "nt":
        return None
    try:
        high, low = luid
        gdi32 = ctypes.WinDLL("gdi32.dll")
        gdi32.D3DKMTOpenAdapterFromLuid.argtypes = [ctypes.POINTER(_OpenAdapterFromLuid)]
        gdi32.D3DKMTOpenAdapterFromLuid.restype = ctypes.c_long
        gdi32.D3DKMTQueryAdapterInfo.argtypes = [ctypes.POINTER(_QueryAdapterInfo)]
        gdi32.D3DKMTQueryAdapterInfo.restype = ctypes.c_long
        gdi32.D3DKMTCloseAdapter.argtypes = [ctypes.POINTER(_CloseAdapter)]
        gdi32.D3DKMTCloseAdapter.restype = ctypes.c_long

        request = _OpenAdapterFromLuid(_Luid(int(low), int(high)), 0)
        status = int(gdi32.D3DKMTOpenAdapterFromLuid(ctypes.byref(request)))
        if status < 0 or request.hAdapter == 0:
            return None
        try:
            count = _physical_adapter_count(gdi32, request.hAdapter)
            if count is None:
                return None
            identities: set[tuple[str, str]] = set()
            for physical_index in range(count):
                hardware = _query_pnp_key(
                    gdi32,
                    request.hAdapter,
                    physical_index,
                    _D3DKMT_PNP_KEY_HARDWARE,
                )
                software = _query_pnp_key(
                    gdi32,
                    request.hAdapter,
                    physical_index,
                    _D3DKMT_PNP_KEY_SOFTWARE,
                )
                if hardware is None or software is None:
                    return None
                identities.add((hardware, software))
            if len(identities) != count:
                return None
            return frozenset(identities)
        finally:
            close = _CloseAdapter(request.hAdapter)
            gdi32.D3DKMTCloseAdapter(ctypes.byref(close))
    except (AttributeError, OSError, TypeError, ValueError):
        return None
