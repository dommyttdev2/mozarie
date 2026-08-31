from __future__ import annotations

from dataclasses import dataclass
import ctypes
import importlib
import os
from types import MethodType
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


def _normalize_device_name(value: str) -> str:
    return " ".join(str(value).strip().casefold().split())


@dataclass(frozen=True)
class DxgiDevice:
    """A physical Windows graphics adapter in DXGI enumeration order."""

    index: int
    name: str
    vendor_id: int
    device_id: int
    subsys_id: int
    revision: int
    dedicated_video_memory: int
    dedicated_system_memory: int
    shared_system_memory: int
    luid_low: int
    luid_high: int

    @property
    def luid(self) -> str:
        return f"{self.luid_high & 0xFFFFFFFF:08X}{self.luid_low & 0xFFFFFFFF:08X}"


def _dxgi_adapter_names() -> list[DxgiDevice]:
    """Enumerate physical adapters in the same order used by DirectML device_id."""
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

        devices: list[DxgiDevice] = []
        index = 0
        try:
            while True:
                adapter = ctypes.c_void_p()
                hr = enum_adapters(factory, index, ctypes.byref(adapter))
                if hr < 0 or not adapter:
                    break
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
                    desc = _AdapterDesc()
                    if get_desc(adapter, ctypes.byref(desc)) >= 0:
                        devices.append(
                            DxgiDevice(
                                index=index,
                                name=desc.Description.rstrip("\0"),
                                vendor_id=int(desc.VendorId),
                                device_id=int(desc.DeviceId),
                                subsys_id=int(desc.SubSysId),
                                revision=int(desc.Revision),
                                dedicated_video_memory=int(desc.DedicatedVideoMemory),
                                dedicated_system_memory=int(desc.DedicatedSystemMemory),
                                shared_system_memory=int(desc.SharedSystemMemory),
                                luid_low=int(desc.AdapterLuid.LowPart),
                                luid_high=int(desc.AdapterLuid.HighPart),
                            )
                        )
                finally:
                    adapter_release = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)(
                        ctypes.cast(
                            adapter,
                            ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p)),
                        ).contents[2]
                    )
                    adapter_release(adapter)
                index += 1
        finally:
            release(factory)
        return devices
    except (AttributeError, OSError, TypeError, ValueError):
        return []


def _log_gpu_diagnostics(stage: str, *, logical_device_id: int | None = None, torch_index: int | None = None, directml_index: int | None = None) -> None:
    """Print detailed DirectML GPU mapping information for live troubleshooting."""
    try:
        directml = directml_module()
        torch_count = int(directml.device_count())
        torch_devices = [
            str(directml.device_name(index)).rstrip("\0")
            for index in range(torch_count)
        ]
    except (ImportError, OSError, RuntimeError, TypeError, ValueError) as exc:
        print(f"[Mozarie GPU] stage={stage} DirectML enumeration failed: {exc!r}", flush=True)
        return

    dxgi_devices = _dxgi_adapter_names()
    pid = os.getpid()
    print(
        f"[Mozarie GPU] stage={stage} pid={pid} backend=directml "
        f"logical={logical_device_id} torch_index={torch_index} dml_index={directml_index}",
        flush=True,
    )
    if dxgi_devices:
        for device in dxgi_devices:
            print(
                f"[Mozarie GPU] DXGI index={device.index} name={device.name!r} "
                f"vendor_id=0x{device.vendor_id:04X} device_id=0x{device.device_id:04X} "
                f"subsys_id=0x{device.subsys_id:08X} revision=0x{device.revision:02X} "
                f"dedicated_video_memory={device.dedicated_video_memory} "
                f"shared_system_memory={device.shared_system_memory} luid={device.luid}",
                flush=True,
            )
    else:
        print("[Mozarie GPU] DXGI enumeration unavailable", flush=True)
    for index, name in enumerate(torch_devices):
        print(f"[Mozarie GPU] torch-directml index={index} name={name!r}", flush=True)

    if dxgi_devices and torch_devices:
        for dxgi_device in dxgi_devices:
            matches = [
                index
                for index, name in enumerate(torch_devices)
                if _normalize_device_name(name) == _normalize_device_name(dxgi_device.name)
            ]
            print(
                f"[Mozarie GPU] NAME-MATCH DXGI index={dxgi_device.index} "
                f"name={dxgi_device.name!r} torch_indices={matches}",
                flush=True,
            )


def directml_devices(module: Any | None = None) -> list[dict[str, object]]:
    """Expose DirectML GPUs using DXGI's physical adapter order."""
    directml = module or directml_module()
    dxgi_devices = _dxgi_adapter_names()
    if dxgi_devices:
        torch_names = [
            str(directml.device_name(index)).rstrip("\0")
            for index in range(int(directml.device_count()))
        ]
        devices: list[dict[str, object]] = []
        for adapter in dxgi_devices:
            matched = [
                name for name in torch_names
                if _normalize_device_name(name) == _normalize_device_name(adapter.name)
            ]
            if not matched:
                continue
            devices.append(RuntimeDevice(
                id=adapter.index,
                name=adapter.name,
                backend="directml",
            ).payload())
        if devices:
            _log_gpu_diagnostics("device-list")
            return devices
    devices = [
        RuntimeDevice(
            id=index,
            name=str(directml.device_name(index)).rstrip("\0"),
            backend="directml",
        ).payload()
        for index in range(int(directml.device_count()))
    ]
    _log_gpu_diagnostics("device-list-fallback")
    return devices


def _resolve_directml_torch_index(logical_device_id: int, directml: Any) -> int:
    """Translate a DXGI/logical DirectML adapter id to torch-directml's index."""
    dxgi_devices = _dxgi_adapter_names()
    if not dxgi_devices:
        return int(logical_device_id)
    selected = next((device for device in dxgi_devices if device.index == int(logical_device_id)), None)
    if selected is None:
        return int(logical_device_id)
    target_name = _normalize_device_name(selected.name)
    torch_count = int(directml.device_count())
    matches = [
        index
        for index in range(torch_count)
        if _normalize_device_name(str(directml.device_name(index)).rstrip("\0")) == target_name
    ]
    return matches[0] if len(matches) == 1 else int(logical_device_id)


def torch_device(torch: Any, provider: str, device_id: int = 0, *, backend: str | None = None) -> Any:
    if provider.lower() == "cpu":
        return "cpu"
    selected = backend or runtime_backend(torch_module=torch)
    if selected == "cuda":
        resolved = int(device_id)
        print(f"[Mozarie GPU] stage=torch-device backend=cuda logical={int(device_id)} resolved={resolved} pid={os.getpid()}", flush=True)
        return f"cuda:{resolved}"
    if selected == "directml":
        directml = directml_module()
        torch_index = _resolve_directml_torch_index(int(device_id), directml)
        _log_gpu_diagnostics("torch-device", logical_device_id=int(device_id), torch_index=torch_index, directml_index=int(device_id))
        return directml.device(torch_index)
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
