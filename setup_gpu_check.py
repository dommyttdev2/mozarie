"""Small, quiet GPU smoke test used by setup.bat."""

from __future__ import annotations

import ctypes
import os
from pathlib import Path
import subprocess
import sys
import warnings

from mozarie.config import SettingsStore
from mozarie.runtime_profile import selected_profile, validate


CPU_READY_MESSAGE = "[Mozarie] CPU detection runtime is ready. / CPU検出ランタイムの準備ができました。"
CPU_SAVE_FAILED_MESSAGE = "[Mozarie] CPU detection runtime passed its check, but the CPU setting could not be saved. Setup stopped; check config/local.json and run setup again. / CPU検出ランタイムの確認はできましたが、CPU設定を保存できませんでした。config/local.jsonを確認して、setup.bat をもう一度実行してください。"
RUNTIME_IMPORT_FAILED_MESSAGE = "[Mozarie] Required packages could not be loaded. Setup stopped; run setup.bat again. / 必要なパッケージを読み込めませんでした。setup.bat をもう一度実行してください。"
CPU_RUNTIME_FAILED_MESSAGE = "[Mozarie] The CPU detection runtime could not start. Setup stopped; run setup.bat again. / CPUで検出処理を開始できませんでした。setup.bat をもう一度実行してください。"
SETTINGS_READ_FAILED_MESSAGE = "[Mozarie] Settings could not be read. Setup stopped; check config/local.json and run setup.bat again. / 設定を読み込めませんでした。config/local.json を確認してから setup.bat を実行してください。"
PROFILE_UNAVAILABLE_MESSAGE = "[Mozarie] The selected runtime could not be identified. Setup stopped; run setup.bat again. / 選択されたランタイムを確認できませんでした。setup.bat をもう一度実行してください。"
CUDA_RUNTIME_FAILED_MESSAGE = "[Mozarie] CUDA detection runtime could not start. Setup stopped; check the NVIDIA driver and run setup.bat again. / CUDA検出ランタイムを開始できませんでした。NVIDIAドライバーを確認して、setup.bat をもう一度実行してください。"
DIRECTML_RUNTIME_FAILED_MESSAGE = "[Mozarie] DirectML detection runtime could not start. Setup stopped; check the GPU driver and run setup.bat again. / DirectML検出ランタイムを開始できませんでした。GPUドライバーを確認して、setup.bat をもう一度実行してください。"
APP_DIR = Path(__file__).resolve().parent
_DXGI_ERROR_NOT_FOUND = -2005270526


def _runtime_modules():
    import numpy as np
    import onnxruntime as ort
    import torch
    from onnxruntime import datasets
    return np, ort, torch, datasets


def _gpu_is_ready(np, ort, torch, datasets, device: int) -> bool:
    # Some builds warn while merely enumerating an unsupported secondary GPU.
    # Do not hide warnings outside this one capability probe.
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning, message=r"\s*Found GPU\d+")
        warnings.filterwarnings(
            "ignore",
            category=UserWarning,
            message=r"\s*NVIDIA .* with CUDA capability sm_\d+ is not compatible with the current PyTorch installation",
        )
        cuda_available = torch.cuda.is_available()
        count = torch.cuda.device_count() if cuda_available else 0
        if not cuda_available or "CUDAExecutionProvider" not in ort.get_available_providers():
            return False
        if device < 0 or device >= count:
            return False
        torch.ones((1,), device=f"cuda:{device}").add_(1).cpu()
        session = ort.InferenceSession(
            datasets.get_example("mul_1.onnx"), providers=["CUDAExecutionProvider"], provider_options=[{"device_id": str(device)}],
        )
        session.disable_fallback()
        if session.get_providers()[0] != "CUDAExecutionProvider":
            return False
        session.run(None, {"X": np.ones((3, 2), dtype=np.float32)})
        return True


def _cpu_is_ready(np, ort, _torch, datasets) -> bool:
    try:
        session = ort.InferenceSession(datasets.get_example("mul_1.onnx"), providers=["CPUExecutionProvider"])
        session.disable_fallback()
        if session.get_providers()[0] != "CPUExecutionProvider":
            return False
        session.run(None, {"X": np.ones((3, 2), dtype=np.float32)})
        return True
    except Exception:
        return False


def _save_cpu_provider() -> bool:
    try:
        SettingsStore(APP_DIR).save({"models": {"provider": "cpu"}})
    except Exception:
        print(CPU_SAVE_FAILED_MESSAGE)
        return False
    print(CPU_READY_MESSAGE)
    return True


def _print_exception_chain(exc: BaseException) -> None:
    """Print concise setup diagnostics without changing fail-closed behavior."""
    seen: set[int] = set()
    current: BaseException | None = exc
    depth = 0
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        prefix = "cause" if depth else "error"
        print(f"[Mozarie] DirectML {prefix}: {type(current).__name__}: {current}")
        current = current.__cause__ or current.__context__
        depth += 1


def _dxgi_extended_snapshot() -> list[dict[str, object]]:  # pragma: no cover - Windows hardware diagnostic
    class _Guid(ctypes.Structure):
        _fields_ = [
            ("Data1", ctypes.c_uint32),
            ("Data2", ctypes.c_uint16),
            ("Data3", ctypes.c_uint16),
            ("Data4", ctypes.c_ubyte * 8),
        ]

    class _Luid(ctypes.Structure):
        _fields_ = [("LowPart", ctypes.c_uint32), ("HighPart", ctypes.c_int32)]

    class _AdapterDesc(ctypes.Structure):
        _fields_ = [
            ("Description", ctypes.c_wchar * 128),
            ("VendorId", ctypes.c_uint32),
            ("DeviceId", ctypes.c_uint32),
            ("SubSysId", ctypes.c_uint32),
            ("Revision", ctypes.c_uint32),
            ("DedicatedVideoMemory", ctypes.c_size_t),
            ("DedicatedSystemMemory", ctypes.c_size_t),
            ("SharedSystemMemory", ctypes.c_size_t),
            ("AdapterLuid", _Luid),
        ]

    dxgi = ctypes.WinDLL("dxgi.dll")
    create_factory = dxgi.CreateDXGIFactory1
    create_factory.argtypes = [ctypes.POINTER(_Guid), ctypes.POINTER(ctypes.c_void_p)]
    create_factory.restype = ctypes.c_long
    iid_factory = _Guid(
        0x7B7166EC,
        0x21C7,
        0x44AE,
        (0xB2, 0x1A, 0xC9, 0xAE, 0x32, 0x1A, 0xE3, 0x69),
    )
    factory = ctypes.c_void_p()
    hr = int(create_factory(ctypes.byref(iid_factory), ctypes.byref(factory)))
    if hr < 0 or not factory:
        raise RuntimeError(f"CreateDXGIFactory1 failed: {hr}")

    factory_vtable = ctypes.cast(factory, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    enum_adapters = ctypes.WINFUNCTYPE(
        ctypes.c_long,
        ctypes.c_void_p,
        ctypes.c_uint,
        ctypes.POINTER(ctypes.c_void_p),
    )(factory_vtable[7])
    release_factory = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)(factory_vtable[2])
    result: list[dict[str, object]] = []
    try:
        index = 0
        while True:
            adapter = ctypes.c_void_p()
            enum_hr = int(enum_adapters(factory, index, ctypes.byref(adapter)))
            if enum_hr == _DXGI_ERROR_NOT_FOUND:
                return result
            if enum_hr < 0 or not adapter:
                raise RuntimeError(f"EnumAdapters({index}) failed: {enum_hr}")
            try:
                adapter_vtable = ctypes.cast(
                    adapter,
                    ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p)),
                ).contents
                get_desc = ctypes.WINFUNCTYPE(
                    ctypes.c_long,
                    ctypes.c_void_p,
                    ctypes.POINTER(_AdapterDesc),
                )(adapter_vtable[8])
                release_adapter = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)(adapter_vtable[2])
                desc = _AdapterDesc()
                desc_hr = int(get_desc(adapter, ctypes.byref(desc)))
                if desc_hr < 0:
                    raise RuntimeError(f"GetDesc({index}) failed: {desc_hr}")
                result.append(
                    {
                        "index": index,
                        "name": desc.Description.rstrip("\0"),
                        "luid": (int(desc.AdapterLuid.HighPart), int(desc.AdapterLuid.LowPart)),
                        "vendor": int(desc.VendorId),
                        "device": int(desc.DeviceId),
                        "subsys": int(desc.SubSysId),
                        "revision": int(desc.Revision),
                        "dedicated_video": int(desc.DedicatedVideoMemory),
                        "dedicated_system": int(desc.DedicatedSystemMemory),
                        "shared_system": int(desc.SharedSystemMemory),
                    }
                )
            finally:
                if adapter:
                    release_adapter(adapter)
            index += 1
    finally:
        release_factory(factory)


def _probe_dml_visible_device(adapter_index: int) -> str:  # pragma: no cover - Windows hardware diagnostic
    """Ask a fresh torch-directml process what one DML-visible adapter exposes."""
    code = (
        "import torch_directml; "
        "c=int(torch_directml.device_count()); "
        "print('count='+str(c)); "
        "[print('device='+str(i)+':'+repr(str(torch_directml.device_name(i)).rstrip(chr(0)))) for i in range(c)]"
    )
    env = dict(os.environ)
    env["DML_VISIBLE_DEVICES"] = str(adapter_index)
    result = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
        env=env,
    )
    stdout = " | ".join(line.strip() for line in result.stdout.splitlines() if line.strip())
    stderr = " | ".join(line.strip() for line in result.stderr.splitlines() if line.strip())
    return f"exit={result.returncode}, stdout={stdout!r}, stderr={stderr!r}"


def _print_directml_identity_snapshot() -> None:  # pragma: no cover - Windows hardware diagnostic
    """Print runtime identities only after a DirectML setup failure."""
    try:
        import torch_directml

        count = int(torch_directml.device_count())
        print(f"[Mozarie] torch-directml devices: {count}")
        for index in range(count):
            name = str(torch_directml.device_name(index)).rstrip("\0")
            memory = None
            gpu_memory = getattr(torch_directml, "gpu_memory", None)
            if callable(gpu_memory):
                try:
                    memory = gpu_memory(index)
                except Exception as exc:
                    memory = f"unavailable ({type(exc).__name__}: {exc})"
            print(f"[Mozarie] torch-directml logical {index}: name={name!r}, gpu_memory={memory!r}")
    except Exception as exc:
        print(f"[Mozarie] torch-directml identity diagnostic failed: {type(exc).__name__}: {exc}")

    try:
        adapters = _dxgi_extended_snapshot()
        print(f"[Mozarie] DXGI adapters: {len(adapters)}")
        for adapter in adapters:
            print(
                f"[Mozarie] DXGI index {adapter['index']}: name={adapter['name']!r}, "
                f"luid={adapter['luid']!r}, vendor=0x{adapter['vendor']:04X}, "
                f"device=0x{adapter['device']:04X}, subsys=0x{adapter['subsys']:08X}, "
                f"revision=0x{adapter['revision']:X}, dedicated_video={adapter['dedicated_video']}, "
                f"dedicated_system={adapter['dedicated_system']}, shared_system={adapter['shared_system']}"
            )
        for adapter in adapters:
            index = int(adapter["index"])
            try:
                probe = _probe_dml_visible_device(index)
                print(f"[Mozarie] DML_VISIBLE_DEVICES={index}: {probe}")
            except Exception as exc:
                print(f"[Mozarie] DML_VISIBLE_DEVICES={index}: diagnostic failed: {type(exc).__name__}: {exc}")
    except Exception as exc:
        print(f"[Mozarie] DXGI identity diagnostic failed: {type(exc).__name__}: {exc}")


def main() -> int:
    try:
        settings = SettingsStore(APP_DIR).load()
        device = int(settings["models"].get("gpu_device", 0))
        profile = selected_profile(APP_DIR / ".venv")
    except Exception:
        print(SETTINGS_READ_FAILED_MESSAGE)
        return 1
    if profile not in {"cuda", "directml", "cpu"}:
        print(PROFILE_UNAVAILABLE_MESSAGE)
        return 1
    if profile == "directml":
        try:
            validate(profile, device)
            print(f"[Mozarie] DirectML GPU {device} is ready.")
            return 0
        except Exception as exc:
            print(f"[Mozarie] DirectML setup probe failed for logical GPU {device}.")
            _print_exception_chain(exc)
            _print_directml_identity_snapshot()
            print(DIRECTML_RUNTIME_FAILED_MESSAGE)
            return 1
    try:
        runtime = _runtime_modules()
    except Exception:
        print(RUNTIME_IMPORT_FAILED_MESSAGE)
        return 1
    if profile == "cuda":
        try:
            if _gpu_is_ready(*runtime, device):
                print("[Mozarie] GPU is ready.")
                return 0
        except Exception:
            pass
        print(CUDA_RUNTIME_FAILED_MESSAGE)
        return 1
    if not _cpu_is_ready(*runtime):
        print(CPU_RUNTIME_FAILED_MESSAGE)
        return 1
    return 0 if _save_cpu_provider() else 1


if __name__ == "__main__":
    raise SystemExit(main())
