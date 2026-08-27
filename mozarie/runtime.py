from __future__ import annotations

import ctypes
from dataclasses import dataclass
from functools import lru_cache
import importlib
import os
from types import MethodType
from typing import Any


BACKENDS = {"cuda", "directml", "cpu"}
_DXGI_ERROR_NOT_FOUND = 0x887A0002


class _Guid(ctypes.Structure):
    _fields_ = [
        ("data1", ctypes.c_uint32),
        ("data2", ctypes.c_uint16),
        ("data3", ctypes.c_uint16),
        ("data4", ctypes.c_ubyte * 8),
    ]


class _Luid(ctypes.Structure):
    _fields_ = [("low_part", ctypes.c_uint32), ("high_part", ctypes.c_int32)]


class _DxgiAdapterDesc(ctypes.Structure):
    _fields_ = [
        ("description", ctypes.c_wchar * 128),
        ("vendor_id", ctypes.c_uint32),
        ("device_id", ctypes.c_uint32),
        ("subsystem_id", ctypes.c_uint32),
        ("revision", ctypes.c_uint32),
        ("dedicated_video_memory", ctypes.c_size_t),
        ("dedicated_system_memory", ctypes.c_size_t),
        ("shared_system_memory", ctypes.c_size_t),
        ("adapter_luid", _Luid),
    ]


@dataclass(frozen=True)
class _DxgiAdapter:
    name: str
    luid: tuple[int, int]


class DirectMLDeviceMappingError(RuntimeError):
    """The selected torch-directml device cannot be proven to match DXGI."""


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


def _com_method(pointer: ctypes.c_void_p, index: int, result: Any, *arguments: Any) -> Any:
    table = ctypes.cast(pointer, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    return ctypes.WINFUNCTYPE(result, ctypes.c_void_p, *arguments)(table[index])


@lru_cache(maxsize=1)
def _dxgi_adapters() -> tuple[_DxgiAdapter, ...]:
    """Return DXGI adapters and their stable LUIDs in ORT enumeration order."""
    if os.name != "nt":
        return ()
    factory = ctypes.c_void_p()
    factory_iid = _Guid(
        0x770AAE78,
        0xF26F,
        0x4DBA,
        (ctypes.c_ubyte * 8)(0xA8, 0x29, 0x25, 0x3C, 0x83, 0xD1, 0xB3, 0x87),
    )
    create_factory = ctypes.WinDLL("dxgi").CreateDXGIFactory1
    create_factory.argtypes = [ctypes.POINTER(_Guid), ctypes.POINTER(ctypes.c_void_p)]
    create_factory.restype = ctypes.c_long
    if create_factory(ctypes.byref(factory_iid), ctypes.byref(factory)) != 0:
        return ()
    adapters: list[_DxgiAdapter] = []
    try:
        enum_adapters = _com_method(
            factory, 7, ctypes.c_long, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p)
        )
        for index in range(64):
            adapter = ctypes.c_void_p()
            result = enum_adapters(factory, index, ctypes.byref(adapter))
            if result != 0:
                if result & 0xFFFFFFFF == _DXGI_ERROR_NOT_FOUND:
                    break
                return ()
            try:
                description = _DxgiAdapterDesc()
                get_description = _com_method(
                    adapter, 8, ctypes.c_long, ctypes.POINTER(_DxgiAdapterDesc)
                )
                if get_description(adapter, ctypes.byref(description)) != 0:
                    return ()
                adapters.append(_DxgiAdapter(
                    str(description.description).rstrip("\0"),
                    (int(description.adapter_luid.low_part), int(description.adapter_luid.high_part)),
                ))
            finally:
                _com_method(adapter, 2, ctypes.c_ulong)(adapter)
    finally:
        _com_method(factory, 2, ctypes.c_ulong)(factory)
    return tuple(adapters)


def _luid_key(value: Any) -> tuple[int, int] | None:
    def normalize(low: Any, high: Any) -> tuple[int, int]:
        normalized_low = int(low) & 0xFFFFFFFF
        normalized_high = int(high) & 0xFFFFFFFF
        if normalized_high >= 0x80000000:
            normalized_high -= 0x100000000
        return normalized_low, normalized_high

    if isinstance(value, _Luid):
        return normalize(value.low_part, value.high_part)
    if isinstance(value, int):
        return normalize(value, value >> 32)
    if isinstance(value, (tuple, list)) and len(value) == 2:
        try:
            return normalize(value[0], value[1])
        except (TypeError, ValueError):
            return None
    return None


def _directml_luid(module: Any, device_id: int) -> tuple[int, int] | None:
    for attribute in ("device_luid", "adapter_luid"):
        getter = getattr(module, attribute, None)
        if callable(getter):
            return _luid_key(getter(device_id))
    return None


def directml_ort_device_id(device_id: int, module: Any | None = None) -> int:
    """Translate a torch-directml index to ONNX Runtime's DXGI adapter index.

    torch-directml orders adapters by GPU preference while the DirectML ONNX
    Runtime provider uses DXGI enumeration order. The two numeric IDs therefore
    cannot be shared on multi-GPU systems.
    """
    directml = module or directml_module()
    selected_id = int(device_id)
    count = int(directml.device_count())
    if selected_id < 0 or selected_id >= count:
        raise DirectMLDeviceMappingError(f"DirectML device {selected_id} is unavailable.")
    adapters = _dxgi_adapters()
    selected_luid = _directml_luid(directml, selected_id)
    if selected_luid is not None:
        matches = [index for index, adapter in enumerate(adapters) if adapter.luid == selected_luid]
        if len(matches) == 1:
            return matches[0]
        reason = "no DXGI adapter" if not matches else "multiple DXGI adapters"
        raise DirectMLDeviceMappingError(
            f"DirectML device {selected_id} LUID has {reason} with the same identity."
        )
    if count == 1 and len(adapters) == 1:
        return 0
    raise DirectMLDeviceMappingError(
        "The selected DirectML GPU cannot be matched to ONNX Runtime safely. "
        "Multiple adapters require an LUID-capable torch-directml runtime."
    )


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


def patch_directml_sam_prompt_encoder(model: Any, torch: Any) -> None:
    """Avoid torch-directml failures on SAM's zero-length tensor operations."""
    encoder = model.prompt_encoder
    if getattr(encoder, "_mozarie_directml_safe", False):
        return

    def embed_points(this: Any, points: Any, labels: Any, pad: bool) -> Any:
        points = points + 0.5
        if pad:
            padding_point = torch.zeros((points.shape[0], 1, 2), device=points.device)
            padding_label = -torch.ones((labels.shape[0], 1), device=labels.device)
            points = torch.cat([points, padding_point], dim=1)
            labels = torch.cat([labels, padding_label], dim=1)
        point_embedding = this.pe_layer.forward_with_coords(points, this.input_image_size)
        # Boolean assignment with no selected elements fails in torch-directml.
        # Arithmetic masks preserve SAM's result without constructing a 0x256 view.
        not_a_point = (labels == -1).unsqueeze(-1)
        point_embedding = torch.where(
            not_a_point,
            this.not_a_point_embed.weight.reshape(1, 1, -1),
            point_embedding,
        )
        for label, embedding in enumerate(this.point_embeddings[:2]):
            weight = (labels == label).unsqueeze(-1).to(dtype=point_embedding.dtype)
            point_embedding = point_embedding + weight * embedding.weight.reshape(1, 1, -1)
        return point_embedding

    def forward(this: Any, points: Any, boxes: Any, masks: Any) -> tuple[Any, Any]:
        batch_size = this._get_batch_size(points, boxes, masks)
        sparse_parts = []
        if points is not None:
            coordinates, labels = points
            sparse_parts.append(this._embed_points(coordinates, labels, pad=boxes is None))
        if boxes is not None:
            sparse_parts.append(this._embed_boxes(boxes))
        if not sparse_parts:
            sparse_embeddings = torch.empty(
                (batch_size, 0, this.embed_dim), device=this._get_device()
            )
        elif len(sparse_parts) == 1:
            sparse_embeddings = sparse_parts[0]
        else:
            sparse_embeddings = torch.cat(sparse_parts, dim=1)

        if masks is not None:
            dense_embeddings = this._embed_masks(masks)
        else:
            dense_embeddings = this.no_mask_embed.weight.reshape(1, -1, 1, 1).expand(
                batch_size, -1, this.image_embedding_size[0], this.image_embedding_size[1]
            )
        return sparse_embeddings, dense_embeddings

    encoder._embed_points = MethodType(embed_points, encoder)
    encoder.forward = MethodType(forward, encoder)
    encoder._mozarie_directml_safe = True
