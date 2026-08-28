"""Small, quiet GPU smoke test used by setup.bat."""

from __future__ import annotations

from pathlib import Path
import warnings

from mozarie.config import SettingsStore


CPU_MESSAGE = "[Mozarie] GPU unavailable. Switched the detection runtime to CPU; change it later in Settings. / GPUは利用できません。検出設定をCPUへ切り替えました。後で設定から変更できます。"
CPU_SAVE_FAILED_MESSAGE = "[Mozarie] GPU unavailable, but switching to CPU could not be saved. Setup stopped; check config/local.json and run setup again. / GPUは利用できず、CPUへの切替も保存できませんでした。config/local.jsonを確認して、setupをもう一度実行してください。"
APP_DIR = Path(__file__).resolve().parent


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
        warnings.filterwarnings("ignore", category=UserWarning, message=r".*CUDA.*")
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


def _switch_to_cpu() -> bool:
    try:
        SettingsStore(APP_DIR).save({"models": {"provider": "cpu"}})
    except Exception:
        print(CPU_SAVE_FAILED_MESSAGE)
        return False
    print(CPU_MESSAGE)
    return True


def main() -> int:
    try:
        settings = SettingsStore(APP_DIR).load()
        device = int(settings["models"].get("gpu_device", 0))
        if not _gpu_is_ready(*_runtime_modules(), device):
            return 0 if _switch_to_cpu() else 1
    except Exception:
        return 0 if _switch_to_cpu() else 1
    print("[Mozarie] GPU is ready.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
