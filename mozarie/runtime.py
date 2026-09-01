from __future__ import annotations

from dataclasses import dataclass
import ctypes
import importlib
import os
from types import MethodType
from typing import Any


BACKENDS = {"cuda", "directml", "cpu"}
_DXGI_ERROR_NOT_FOUND = -2005270526


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


def _normalize_device_name(value: str) -> str:
    return " ".join(str(value).strip().casefold().split())


@dataclass(frozen=True)
class DxgiDevice:
    index: int
    name: str
    luid: tuple[int, int] | None = None


def _enumerate_dxgi_adapter_names(
    enum_adapter: Any,
    describe_adapter: Any,
    release_adapter: Any,
) -> list[DxgiDevice]:
    """Enumerate a complete DXGI adapter list or fail closed.

    Only DXGI_ERROR_NOT_FOUND is a successful end-of-list signal. Any other
    EnumAdapters failure, a null adapter, or a descriptor failure invalidates
    the whole enumeration so callers never reason from a partial list.
    """
    devices: list[DxgiDevice] = []
    index = 0
    while True:
        hr, adapter = enum_adapter(index)
        hr = int(hr)
        if hr == _DXGI_ERROR_NOT_FOUND:
            return devices
        if hr < 0 or not adapter:
            return []
        try:
            description = describe_adapter(adapter)
            desc_hr = int(description[0])
            if desc_hr < 0:
                return []
            name = str(description[1]).rstrip("\0")
            luid = description[2] if len(description) > 2 else None
            devices.append(DxgiDevice(index=index, name=name, luid=luid))
        finally:
            release_adapter(adapter)
        index += 1


def _dxgi_adapter_names() -> list[DxgiDevice]:  # pragma: no cover
    """Enumerate Windows DXGI adapters in ONNX Runtime DirectML order."""
    if os.name != "nt":
        return []

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

    try:
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
        if create_factory(ctypes.byref(iid_factory), ctypes.byref(factory)) < 0 or not factory:
            return []

        factory_vtable = ctypes.cast(factory, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
        enum_adapters = ctypes.WINFUNCTYPE(
            ctypes.c_long,
            ctypes.c_void_p,
            ctypes.c_uint,
            ctypes.POINTER(ctypes.c_void_p),
        )(factory_vtable[7])
        release = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)(factory_vtable[2])

        def enum_adapter(index: int) -> tuple[int, ctypes.c_void_p]:
            adapter = ctypes.c_void_p()
            return int(enum_adapters(factory, index, ctypes.byref(adapter))), adapter

        def describe_adapter(
            adapter: ctypes.c_void_p,
        ) -> tuple[int, str, tuple[int, int]]:
            adapter_vtable = ctypes.cast(
                adapter,
                ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p)),
            ).contents
            get_desc = ctypes.WINFUNCTYPE(
                ctypes.c_long,
                ctypes.c_void_p,
                ctypes.POINTER(_AdapterDesc),
            )(adapter_vtable[8])
            desc = _AdapterDesc()
            hr = int(get_desc(adapter, ctypes.byref(desc)))
            return (
                hr,
                desc.Description.rstrip("\0"),
                (int(desc.AdapterLuid.HighPart), int(desc.AdapterLuid.LowPart)),
            )

        def release_adapter(adapter: ctypes.c_void_p) -> None:
            adapter_release = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)(
                ctypes.cast(
                    adapter,
                    ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p)),
                ).contents[2]
            )
            adapter_release(adapter)

        try:
            return _enumerate_dxgi_adapter_names(enum_adapter, describe_adapter, release_adapter)
        finally:
            release(factory)
    except (AttributeError, OSError, TypeError, ValueError):
        return []


def directml_onnx_device_id(
    logical_device_id: int,
    *,
    module: Any | None = None,
    adapters: list[DxgiDevice] | None = None,
    physical_identity_resolver: Any | None = None,
) -> int:
    """Resolve a torch-directml logical id to one unique physical DXGI GPU.

    torch-directml and ONNX Runtime DirectML may enumerate the same physical
    GPUs in different orders. The logical id is first resolved by normalized
    GPU name. Duplicate DXGI entries are accepted only when Windows proves that
    every matching entry identifies one physical adapter: either all entries
    have one AdapterLuid, or their distinct LUIDs resolve through D3DKMT to the
    same complete set of physical hardware/software PnP identities. Missing or
    conflicting identity fails closed; numeric device ids are never used as a
    fallback.
    """
    logical = int(logical_device_id)
    try:
        directml = module or directml_module()
        count = int(directml.device_count())
        if logical < 0 or logical >= count:
            raise ValueError(f"Invalid DirectML logical device id: {logical}")
        selected_name = str(directml.device_name(logical)).rstrip("\0")
    except (AttributeError, ImportError, OSError, RuntimeError, TypeError, ValueError) as exc:
        raise RuntimeError("Unable to identify the selected DirectML GPU") from exc

    resolved_adapters = _dxgi_adapter_names() if adapters is None else list(adapters)
    if not resolved_adapters:
        raise RuntimeError("Unable to enumerate DXGI adapters completely")

    target = _normalize_device_name(selected_name)
    matches = [
        adapter
        for adapter in resolved_adapters
        if _normalize_device_name(adapter.name) == target
    ]
    if len(matches) == 1:
        return matches[0].index
    if len(matches) > 1:
        luids = {adapter.luid for adapter in matches}
        if None not in luids and len(luids) == 1:
            return matches[0].index
        if None not in luids:
            resolver = physical_identity_resolver
            if resolver is None:
                try:
                    from .directml_identity import physical_adapter_identity
                except (ImportError, OSError) as exc:
                    raise RuntimeError(
                        "Unable to map the selected DirectML GPU to one physical DXGI adapter"
                    ) from exc
                resolver = physical_adapter_identity
            try:
                identities = [resolver(adapter.luid) for adapter in matches]
            except (AttributeError, OSError, RuntimeError, TypeError, ValueError) as exc:
                raise RuntimeError(
                    "Unable to map the selected DirectML GPU to one physical DXGI adapter"
                ) from exc
            if all(identity is not None for identity in identities) and len(set(identities)) == 1:
                # DXGI enumeration order is the ONNX Runtime DirectML device order.
                # The matching entries are proven aliases of one physical GPU;
                # use the first enumerated alias, never a numeric-index heuristic.
                return matches[0].index
    raise RuntimeError("Unable to map the selected DirectML GPU to one physical DXGI adapter")


def directml_devices(module: Any | None = None) -> list[dict[str, object]]:
    """Expose physical GPU choices using torch-directml's stable device list."""
    directml = module or directml_module()
    return [
        RuntimeDevice(
            id=index,
            name=str(directml.device_name(index)).rstrip("\0"),
            backend="directml",
        ).payload()
        for index in range(int(directml.device_count()))
    ]


def torch_device(torch: Any, provider: str, device_id: int = 0, *, backend: str | None = None) -> Any:
    if provider.lower() == "cpu":
        return "cpu"
    selected = backend or runtime_backend(torch_module=torch)
    if selected == "cuda":
        return f"cuda:{int(device_id)}"
    if selected == "directml":
        directml = directml_module()
        return directml.device(int(device_id))
    raise RuntimeError("No GPU runtime is available")


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
