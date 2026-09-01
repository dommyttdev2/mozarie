"""Probe DXGI adapter LUIDs through D3DKMT physical-adapter PnP identities.

Diagnostic only: this script does not participate in Mozarie runtime mapping.
"""
from __future__ import annotations

import ctypes
import json

DXGI_ERROR_NOT_FOUND = -2005270526
KMTQAITYPE_PHYSICALADAPTERPNPKEY = 41
D3DKMT_PNP_KEY_HARDWARE = 1
D3DKMT_PNP_KEY_SOFTWARE = 2


class GUID(ctypes.Structure):
    _fields_ = [("Data1", ctypes.c_uint32), ("Data2", ctypes.c_uint16), ("Data3", ctypes.c_uint16), ("Data4", ctypes.c_ubyte * 8)]


class LUID(ctypes.Structure):
    _fields_ = [("LowPart", ctypes.c_uint32), ("HighPart", ctypes.c_int32)]


class DXGI_ADAPTER_DESC(ctypes.Structure):
    _fields_ = [
        ("Description", ctypes.c_wchar * 128), ("VendorId", ctypes.c_uint32), ("DeviceId", ctypes.c_uint32),
        ("SubSysId", ctypes.c_uint32), ("Revision", ctypes.c_uint32), ("DedicatedVideoMemory", ctypes.c_size_t),
        ("DedicatedSystemMemory", ctypes.c_size_t), ("SharedSystemMemory", ctypes.c_size_t), ("AdapterLuid", LUID),
    ]


class D3DKMT_OPENADAPTERFROMLUID(ctypes.Structure):
    _fields_ = [("AdapterLuid", LUID), ("hAdapter", ctypes.c_uint32)]


class D3DKMT_CLOSEADAPTER(ctypes.Structure):
    _fields_ = [("hAdapter", ctypes.c_uint32)]


class D3DKMT_QUERYADAPTERINFO(ctypes.Structure):
    _fields_ = [
        ("hAdapter", ctypes.c_uint32),
        ("Type", ctypes.c_int),
        ("pPrivateDriverData", ctypes.c_void_p),
        ("PrivateDriverDataSize", ctypes.c_uint32),
    ]


class D3DKMT_QUERY_PHYSICAL_ADAPTER_PNP_KEY(ctypes.Structure):
    _fields_ = [
        ("PhysicalAdapterIndex", ctypes.c_uint32),
        ("PnPKeyType", ctypes.c_int),
        ("pDest", ctypes.POINTER(ctypes.c_wchar)),
        ("pCchDest", ctypes.POINTER(ctypes.c_uint32)),
    ]


def _guid(data1, data2, data3, data4):
    return GUID(data1, data2, data3, (ctypes.c_ubyte * 8)(*data4))


IID_IDXGIFACTORY1 = _guid(0x770AAE78, 0xF26F, 0x4DBA, (0xA8, 0x29, 0x25, 0x3C, 0x83, 0xD1, 0xB3, 0x87))


def _method(ptr, index, restype, *argtypes):
    vtable = ctypes.cast(ptr, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    return ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)(vtable[index])


def _release(ptr):
    if ptr:
        _method(ptr, 2, ctypes.c_ulong)(ptr)


def _dxgi_adapters():
    dxgi = ctypes.WinDLL("dxgi.dll")
    create = dxgi.CreateDXGIFactory1
    create.argtypes = [ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p)]
    create.restype = ctypes.c_long
    factory = ctypes.c_void_p()
    hr = int(create(ctypes.byref(IID_IDXGIFACTORY1), ctypes.byref(factory)))
    if hr < 0 or not factory:
        raise RuntimeError(f"CreateDXGIFactory1 failed: {hr}")
    result = []
    try:
        enum_adapters = _method(factory, 12, ctypes.c_long, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p))
        index = 0
        while True:
            adapter = ctypes.c_void_p()
            enum_hr = int(enum_adapters(factory, index, ctypes.byref(adapter)))
            if enum_hr == DXGI_ERROR_NOT_FOUND:
                break
            if enum_hr < 0 or not adapter:
                raise RuntimeError(f"EnumAdapters1({index}) failed: {enum_hr}")
            try:
                desc = DXGI_ADAPTER_DESC()
                desc_hr = int(_method(adapter, 8, ctypes.c_long, ctypes.POINTER(DXGI_ADAPTER_DESC))(adapter, ctypes.byref(desc)))
                if desc_hr < 0:
                    raise RuntimeError(f"GetDesc({index}) failed: {desc_hr}")
                result.append({
                    "index": index,
                    "name": desc.Description.rstrip("\0"),
                    "luid": (int(desc.AdapterLuid.HighPart), int(desc.AdapterLuid.LowPart)),
                    "vendor": int(desc.VendorId),
                    "device": int(desc.DeviceId),
                    "subsys": int(desc.SubSysId),
                    "revision": int(desc.Revision),
                })
            finally:
                _release(adapter)
            index += 1
        return result
    finally:
        _release(factory)


def _query_pnp_key(gdi32, handle: int, physical_index: int, key_type: int):
    # 1024 WCHARs is deliberately generous; query structure also reports actual length.
    buffer = ctypes.create_unicode_buffer(1024)
    chars = ctypes.c_uint32(len(buffer))
    payload = D3DKMT_QUERY_PHYSICAL_ADAPTER_PNP_KEY(
        physical_index,
        key_type,
        ctypes.cast(buffer, ctypes.POINTER(ctypes.c_wchar)),
        ctypes.pointer(chars),
    )
    query = D3DKMT_QUERYADAPTERINFO(
        handle,
        KMTQAITYPE_PHYSICALADAPTERPNPKEY,
        ctypes.cast(ctypes.pointer(payload), ctypes.c_void_p),
        ctypes.sizeof(payload),
    )
    status = int(gdi32.D3DKMTQueryAdapterInfo(ctypes.byref(query)))
    if status < 0:
        return {"status": status, "value": None, "chars": int(chars.value)}
    return {"status": status, "value": buffer.value, "chars": int(chars.value)}


def _kmt_identity(adapter):
    gdi32 = ctypes.WinDLL("gdi32.dll")
    gdi32.D3DKMTOpenAdapterFromLuid.argtypes = [ctypes.POINTER(D3DKMT_OPENADAPTERFROMLUID)]
    gdi32.D3DKMTOpenAdapterFromLuid.restype = ctypes.c_long
    gdi32.D3DKMTQueryAdapterInfo.argtypes = [ctypes.POINTER(D3DKMT_QUERYADAPTERINFO)]
    gdi32.D3DKMTQueryAdapterInfo.restype = ctypes.c_long
    gdi32.D3DKMTCloseAdapter.argtypes = [ctypes.POINTER(D3DKMT_CLOSEADAPTER)]
    gdi32.D3DKMTCloseAdapter.restype = ctypes.c_long

    high, low = adapter["luid"]
    request = D3DKMT_OPENADAPTERFROMLUID(LUID(low, high), 0)
    status = int(gdi32.D3DKMTOpenAdapterFromLuid(ctypes.byref(request)))
    if status < 0 or request.hAdapter == 0:
        return {"open_status": status, "hAdapter": int(request.hAdapter)}
    try:
        # Most ordinary display adapters have one physical adapter at index 0.
        # Probe a few indices rather than assuming; unsupported indices fail independently.
        physical = []
        for physical_index in range(4):
            hardware = _query_pnp_key(gdi32, request.hAdapter, physical_index, D3DKMT_PNP_KEY_HARDWARE)
            software = _query_pnp_key(gdi32, request.hAdapter, physical_index, D3DKMT_PNP_KEY_SOFTWARE)
            physical.append({"physical_index": physical_index, "hardware": hardware, "software": software})
        return {"open_status": status, "hAdapter": int(request.hAdapter), "physical": physical}
    finally:
        close = D3DKMT_CLOSEADAPTER(request.hAdapter)
        gdi32.D3DKMTCloseAdapter(ctypes.byref(close))


def main() -> int:
    adapters = _dxgi_adapters()
    print("dxgi=" + json.dumps(adapters, ensure_ascii=False))
    for adapter in adapters:
        try:
            identity = _kmt_identity(adapter)
        except Exception as exc:
            identity = {"error": f"{type(exc).__name__}: {exc}"}
        print("adapter_identity=" + json.dumps({"dxgi": adapter, "kmt": identity}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
