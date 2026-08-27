from __future__ import annotations

from dataclasses import dataclass
import importlib
import os
from typing import Any


BACKENDS = {"cuda", "directml", "cpu"}


@dataclass(frozen=True)
class RuntimeDevice:
    id: int
    name: str
    backend: str
    supported: bool = True
    architecture: str | None = None
    total_memory: int | None = None

    def payload(self) -> dict[str, object]:
        value: dict[str, object] = {
            "id": self.id,
            "name": self.name,
            "backend": self.backend,
            "supported": self.supported,
        }
        if self.architecture is not None:
            value["architecture"] = self.architecture
        if self.total_memory is not None:
            value["totalMemory"] = self.total_memory
        return value


def configured_backend() -> str | None:
    value = os.environ.get("MOZARIE_RUNTIME", "").strip().lower()
    return value if value in BACKENDS else None


def runtime_backend(*, ort_module: Any | None = None, torch_module: Any | None = None) -> str:
    configured = configured_backend()
    if configured is not None:
        return configured
    if ort_module is not None:
        providers = set(ort_module.get_available_providers())
        if "CUDAExecutionProvider" in providers:
            return "cuda"
        if "DmlExecutionProvider" in providers:
            return "directml"
    if torch_module is not None and getattr(getattr(torch_module, "cuda", None), "is_available", lambda: False)():
        return "cuda"
    try:
        directml = importlib.import_module("torch_directml")
        if int(directml.device_count()) > 0:
            return "directml"
    except (ImportError, OSError, RuntimeError):
        pass
    return "cpu"


def directml_module() -> Any:
    return importlib.import_module("torch_directml")


def torch_device(torch: Any, provider: str, device_id: int = 0, *, backend: str | None = None) -> Any:
    if provider.lower() == "cpu":
        return "cpu"
    selected = backend or runtime_backend(torch_module=torch)
    if selected == "cuda":
        return f"cuda:{int(device_id)}"
    if selected == "directml":
        return directml_module().device(int(device_id))
    raise RuntimeError("No GPU runtime is available")


def directml_devices(module: Any | None = None) -> list[dict[str, object]]:
    directml = module or directml_module()
    devices = []
    for index in range(int(directml.device_count())):
        devices.append(RuntimeDevice(
            id=index,
            name=str(directml.device_name(index)).rstrip("\0"),
            backend="directml",
        ).payload())
    return devices
