from __future__ import annotations

from typing import Any

from .runtime import configured_backend, directml_module


def onnx_backend(*, ort_module: Any | None = None) -> str:
    """Resolve the ONNX Runtime backend independently from the PyTorch backend."""
    configured = configured_backend()
    if configured is not None:
        return configured
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
    configured = configured_backend()
    if configured is not None:
        return configured
    if torch_module is not None:
        cuda = getattr(torch_module, "cuda", None)
        if getattr(cuda, "is_available", lambda: False)():
            return "cuda"
    try:
        directml = directml_module()
        if int(directml.device_count()) > 0:
            return "directml"
    except (ImportError, OSError, RuntimeError):
        pass
    return "cpu"
