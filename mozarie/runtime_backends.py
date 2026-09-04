from __future__ import annotations

import os
from typing import Any

from .runtime import directml_module


PROFILE_BACKENDS: dict[str, tuple[str, str]] = {
    "cuda": ("cuda", "cuda"),
    "directml": ("directml", "directml"),
    "cpu": ("cpu", "cpu"),
    # Windows ROCm uses PyTorch HIP for SAM/HandSegNet while ONNX models
    # continue to use DirectML.  Keep this mapping explicit so neither stack
    # silently inherits the other stack's runtime.
    "rocm": ("directml", "rocm"),
}


def configured_profile() -> str | None:
    value = os.environ.get("MOZARIE_RUNTIME", "").strip().lower()
    return value if value in PROFILE_BACKENDS else None


def onnx_backend(*, ort_module: Any | None = None) -> str:
    """Resolve the ONNX Runtime backend independently from the PyTorch backend."""
    configured = configured_profile()
    if configured is not None:
        return PROFILE_BACKENDS[configured][0]
    if ort_module is None:
        return "cpu"
    providers = set(ort_module.get_available_providers())
    if "CUDAExecutionProvider" in providers:
        return "cuda"
    if "DmlExecutionProvider" in providers:
        return "directml"
    return "cpu"


def torch_backend(*, torch_module: Any | None = None) -> str:
    """Resolve the PyTorch backend independently from the ONNX Runtime backend."""
    configured = configured_profile()
    if configured is not None:
        return PROFILE_BACKENDS[configured][1]
    if torch_module is not None:
        cuda = getattr(torch_module, "cuda", None)
        if getattr(cuda, "is_available", lambda: False)():
            version = getattr(torch_module, "version", None)
            if getattr(version, "hip", None):
                return "rocm"
            return "cuda"
    try:
        directml = directml_module()
        if int(directml.device_count()) > 0:
            return "directml"
    except (ImportError, OSError, RuntimeError):
        pass
    return "cpu"
