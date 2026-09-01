"""Diagnose DirectML logical-device identity using DXGI video-memory telemetry.

This is a standalone diagnostic only. It never participates in Mozarie's runtime
mapping and therefore cannot introduce a numeric-index fallback.
"""
from __future__ import annotations

import argparse
import ctypes
import gc
import json
import time

DXGI_ERROR_NOT_FOUND = -2005270526
DXGI_MEMORY_SEGMENT_GROUP_LOCAL = 0


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


class DXGI_QUERY_VIDEO_MEMORY_INFO(ctypes.Structure):
    _fields_ = [
        ("Budget", ctypes.c_uint64), ("CurrentUsage", ctypes.c_uint64),
        ("AvailableForReservation", ctypes.c_uint64), ("CurrentReservation", ctypes.c_uint64),
    ]


def _guid(data1, data2, data3, data4):
    return GUID(data1, data2, data3, (ctypes.c_ubyte * 8)(*data4))


IID_IDXGIFACTORY1 = _guid(0x770AAE78, 0xF26F, 0x4DBA, (0xA8, 0x29, 0x25, 0x3C, 0x83, 0xD1, 0xB3, 0x87))
IID_IDXGIADAPTER3 = _guid(0x645967A4, 0x1392, 0x4310, (0xA7, 0x98, 0x80, 0x53, 0xCE, 0x3E, 0x93, 0xFD))


def _method(ptr, index, restype, *argtypes):
    vtable = ctypes.cast(ptr, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    return ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)(vtable[index])


def _release(ptr):
    if ptr:
        _method(ptr, 2, ctypes.c_ulong)(ptr)


def _query_interface(ptr, iid):
    out = ctypes.c_void_p()
    hr = int(_method(ptr, 0, ctypes.c_long, ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p))(ptr, ctypes.byref(iid), ctypes.byref(out)))
    if hr < 0 or not out:
        raise RuntimeError(f"QueryInterface failed: {hr}")
    return out


def _open_adapters():
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
        enum_adapters = _method(factory, 12, ctypes.c_long, ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p))
        index = 0
        while True:
            adapter1 = ctypes.c_void_p()
            enum_hr = int(enum_adapters(factory, index, ctypes.byref(adapter1)))
            if enum_hr == DXGI_ERROR_NOT_FOUND:
                break
            if enum_hr < 0 or not adapter1:
                raise RuntimeError(f"EnumAdapters1({index}) failed: {enum_hr}")
            adapter3 = None
            try:
                desc = DXGI_ADAPTER_DESC()
                desc_hr = int(_method(adapter1, 8, ctypes.c_long, ctypes.POINTER(DXGI_ADAPTER_DESC))(adapter1, ctypes.byref(desc)))
                if desc_hr < 0:
                    raise RuntimeError(f"GetDesc({index}) failed: {desc_hr}")
                adapter3 = _query_interface(adapter1, IID_IDXGIADAPTER3)
                result.append({"index": index, "name": desc.Description.rstrip("\0"), "luid": (int(desc.AdapterLuid.HighPart), int(desc.AdapterLuid.LowPart)), "ptr": adapter3})
                adapter3 = None
            finally:
                if adapter3:
                    _release(adapter3)
                _release(adapter1)
            index += 1
        return result
    finally:
        _release(factory)


def _memory_info(adapter):
    info = DXGI_QUERY_VIDEO_MEMORY_INFO()
    query = _method(adapter["ptr"], 14, ctypes.c_long, ctypes.c_uint, ctypes.c_int, ctypes.POINTER(DXGI_QUERY_VIDEO_MEMORY_INFO))
    hr = int(query(adapter["ptr"], 0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, ctypes.byref(info)))
    if hr < 0:
        raise RuntimeError(f"QueryVideoMemoryInfo({adapter['index']}) failed: {hr}")
    return {"budget": int(info.Budget), "usage": int(info.CurrentUsage), "available_for_reservation": int(info.AvailableForReservation), "reservation": int(info.CurrentReservation)}


def _snapshot(adapters):
    return {str(a["index"]): {"name": a["name"], "luid": a["luid"], **_memory_info(a)} for a in adapters}


def _delta(before, after):
    return {key: after[key]["usage"] - before[key]["usage"] for key in before if key in after}


def _make_heavy_onnx(path, size):
    import numpy as np
    import onnx
    from onnx import TensorProto, helper, numpy_helper
    # A persistent square weight keeps a visible allocation alive in the ORT session.
    weight = np.ones((size, size), dtype=np.float32)
    graph = helper.make_graph(
        [helper.make_node("MatMul", ["X", "W"], ["Y"])], "dxgi-memory-probe",
        [helper.make_tensor_value_info("X", TensorProto.FLOAT, [size, size])],
        [helper.make_tensor_value_info("Y", TensorProto.FLOAT, [size, size])],
        [numpy_helper.from_array(weight, name="W")],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
    model.ir_version = min(model.ir_version, 10)
    onnx.save(model, path)


def _probe_ort(adapters, device_id, size, model_path, hold):
    import numpy as np
    import onnxruntime as ort
    before = _snapshot(adapters)
    session = ort.InferenceSession(str(model_path), providers=[("DmlExecutionProvider", {"device_id": str(device_id)})])
    session.disable_fallback()
    x = np.ones((size, size), dtype=np.float32)
    session.run(None, {"X": x})
    time.sleep(hold)
    during = _snapshot(adapters)
    print(f"ORT device_id={device_id} providers={session.get_providers()!r}")
    print("  before=" + json.dumps(before, ensure_ascii=False))
    print("  during=" + json.dumps(during, ensure_ascii=False))
    print("  usage_delta=" + json.dumps(_delta(before, during)))
    del session, x
    gc.collect(); time.sleep(hold)
    print("  after=" + json.dumps(_snapshot(adapters), ensure_ascii=False))


def _probe_torch(adapters, logical, size, hold):
    import torch
    import torch_directml
    device = torch_directml.device(logical)
    before = _snapshot(adapters)
    # Keep several large tensors alive so the selected torch-directml adapter is observable.
    tensors = [torch.ones((size, size), dtype=torch.float32, device=device) for _ in range(4)]
    result = tensors[0] + tensors[1]
    # Force a host read so submitted work completes before telemetry is sampled.
    float(result[0, 0].cpu())
    time.sleep(hold)
    during = _snapshot(adapters)
    print(f"torch logical={logical} name={torch_directml.device_name(logical)!r} device={device!r}")
    print("  before=" + json.dumps(before, ensure_ascii=False))
    print("  during=" + json.dumps(during, ensure_ascii=False))
    print("  usage_delta=" + json.dumps(_delta(before, during)))
    del result, tensors
    gc.collect(); time.sleep(hold)
    print("  after=" + json.dumps(_snapshot(adapters), ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ort-device-ids", nargs="+", type=int, default=[0, 2])
    parser.add_argument("--torch-logical", type=int, default=1)
    parser.add_argument("--size", type=int, default=4096, help="Square float32 matrix dimension; 4096 is ~64 MiB per tensor.")
    parser.add_argument("--hold", type=float, default=0.5)
    args = parser.parse_args()
    from pathlib import Path
    import tempfile
    adapters = _open_adapters()
    try:
        print("adapters=" + json.dumps([{k: v for k, v in a.items() if k != "ptr"} for a in adapters], ensure_ascii=False))
        print("baseline=" + json.dumps(_snapshot(adapters), ensure_ascii=False))
        with tempfile.TemporaryDirectory() as td:
            model_path = Path(td) / "probe.onnx"
            _make_heavy_onnx(model_path, args.size)
            for device_id in args.ort_device_ids:
                print(f"=== ORT {device_id} ===")
                _probe_ort(adapters, device_id, args.size, model_path, args.hold)
        print(f"=== torch-directml logical {args.torch_logical} ===")
        _probe_torch(adapters, args.torch_logical, args.size, args.hold)
    finally:
        for adapter in adapters:
            _release(adapter["ptr"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
