from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any

from . import rocm_probe
from .directml_identity import physical_adapter_identity
from .runtime import (
    DxgiDevice,
    _dxgi_adapter_names,
    _normalize_device_name,
    directml_onnx_device_id,
)


DML_EP = "DmlExecutionProvider"


def describe_dxgi_adapter(adapter: DxgiDevice) -> dict[str, object]:
    return {
        "index": int(adapter.index),
        "name": str(adapter.name),
        "luid": list(adapter.luid) if adapter.luid is not None else None,
    }


def select_directml_adapter(
    rocm_device_name: str,
    adapters: list[DxgiDevice],
    *,
    physical_identity_resolver: Any | None = None,
) -> tuple[int, list[dict[str, object]]]:
    inventory = [describe_dxgi_adapter(adapter) for adapter in adapters]
    target = _normalize_device_name(rocm_device_name)
    matches = [
        adapter for adapter in adapters
        if _normalize_device_name(adapter.name) == target
    ]
    if not matches:
        raise rocm_probe.ProbeError(
            "The ROCm GPU could not be matched to a DXGI adapter. "
            f"ROCm device: {rocm_device_name!r}; DXGI inventory: "
            f"{json.dumps(inventory, ensure_ascii=False)}"
        )
    if len(matches) != 1:
        if physical_identity_resolver is None:
            raise rocm_probe.ProbeError(
                "The ROCm GPU name matched multiple DXGI adapters, so the DirectML "
                "device cannot be selected without guessing. "
                f"ROCm device: {rocm_device_name!r}; DXGI inventory: "
                f"{json.dumps(inventory, ensure_ascii=False)}"
            )
        logical_device = type(
            "_RocmDirectmlIdentity",
            (),
            {
                "device_count": staticmethod(lambda: 1),
                "device_name": staticmethod(lambda _index: rocm_device_name),
            },
        )()
        try:
            resolved = directml_onnx_device_id(
                0,
                module=logical_device,
                adapters=adapters,
                physical_identity_resolver=physical_identity_resolver,
            )
        except (AttributeError, ImportError, OSError, RuntimeError, TypeError, ValueError) as exc:
            raise rocm_probe.ProbeError(
                "The ROCm GPU name matched multiple DXGI adapters, and their physical "
                "identities could not prove that they are aliases of one GPU. "
                f"ROCm device: {rocm_device_name!r}; DXGI inventory: "
                f"{json.dumps(inventory, ensure_ascii=False)}"
            ) from exc
        return int(resolved), inventory
    return int(matches[0].index), inventory


def validate_directml_runtime(ort: Any) -> list[str]:
    providers = list(ort.get_available_providers())
    if DML_EP not in providers:
        raise rocm_probe.ProbeError(
            "onnxruntime-directml does not expose DmlExecutionProvider."
        )
    return providers


def _profile_uses_directml_matmul(events: Any) -> bool:
    if not isinstance(events, list):
        return False
    for event in events:
        if not isinstance(event, dict):
            continue
        args = event.get("args")
        if not isinstance(args, dict):
            continue
        if args.get("op_name") == "MatMul" and args.get("provider") == DML_EP:
            return True
    return False


def run_directml_matmul(
    ort: Any,
    onnx: Any,
    np: Any,
    device_index: int,
) -> dict[str, object]:
    helper = onnx.helper
    tensor_proto = onnx.TensorProto
    input_value = helper.make_tensor_value_info("input", tensor_proto.FLOAT, [1, 64])
    output_value = helper.make_tensor_value_info("output", tensor_proto.FLOAT, [1, 64])
    weights = helper.make_tensor(
        "weights",
        tensor_proto.FLOAT,
        [64, 64],
        [1.0] * (64 * 64),
    )
    graph = helper.make_graph(
        [helper.make_node("MatMul", ["input", "weights"], ["output"], name="mozarie_dml_matmul")],
        "mozarie-rocm-directml-probe",
        [input_value],
        [output_value],
        [weights],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    options.enable_mem_pattern = False
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.enable_profiling = True
    profile_path: Path | None = None
    try:
        session = ort.InferenceSession(
            model.SerializeToString(),
            sess_options=options,
            providers=[
                (DML_EP, {"device_id": int(device_index)}),
                "CPUExecutionProvider",
            ],
        )
        session.disable_fallback()
        active = list(session.get_providers())
        if not active or active[0] != DML_EP:
            raise rocm_probe.ProbeError(
                f"ONNX Runtime activated {active or ['no provider']} instead of {DML_EP}."
            )
        outputs = session.run(
            None,
            {"input": np.ones((1, 64), dtype=np.float32)},
        )
        if not outputs or not bool(
            np.allclose(outputs[0], np.full((1, 64), 64.0, dtype=np.float32))
        ):
            raise rocm_probe.ProbeError("DirectML MatMul returned an unexpected result.")
        profile_path = Path(session.end_profiling())
        try:
            events = json.loads(profile_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise rocm_probe.ProbeError(
                f"DirectML profiling output could not be read: {exc}"
            ) from exc
        if not _profile_uses_directml_matmul(events):
            raise rocm_probe.ProbeError(
                "The ONNX MatMul did not report DmlExecutionProvider execution."
            )
        return {
            "provider": DML_EP,
            "deviceIndex": int(device_index),
            "shape": [1, 64],
            "verified": True,
            "profileVerified": True,
        }
    except rocm_probe.ProbeError:
        raise
    except Exception as exc:
        raise rocm_probe.ProbeError(f"DirectML MatMul probe failed: {exc}") from exc
    finally:
        if profile_path is not None:
            profile_path.unlink(missing_ok=True)


def probe(
    device_index: int | None = None,
    expected_gfx: str = rocm_probe.DEFAULT_EXPECTED_GFX,
    *,
    torch_module: Any | None = None,
    np_module: Any | None = None,
    onnx_module: Any | None = None,
    ort_module: Any | None = None,
    dxgi_adapters: list[DxgiDevice] | None = None,
) -> dict[str, object]:
    rocm_probe.validate_host()
    if any(module is None for module in (torch_module, np_module, onnx_module, ort_module)):
        try:
            if torch_module is None:
                import torch as torch_module
            if np_module is None:
                import numpy as np_module
            if onnx_module is None:
                import onnx as onnx_module
            if ort_module is None:
                import onnxruntime as ort_module
        except Exception as exc:
            raise rocm_probe.ProbeError(
                f"ROCm/DirectML probe dependencies could not be imported: {exc}"
            ) from exc

    runtime = rocm_probe.validate_rocm_torch(torch_module)
    selected_index, rocm_inventory = rocm_probe.select_device(
        torch_module,
        device_index,
        expected_gfx,
    )
    torch_module.cuda.set_device(selected_index)
    selected = rocm_inventory[selected_index]
    providers = validate_directml_runtime(ort_module)
    adapters = _dxgi_adapter_names() if dxgi_adapters is None else list(dxgi_adapters)
    if not adapters:
        raise rocm_probe.ProbeError("DXGI adapter enumeration returned no devices.")
    dml_device_index, dxgi_inventory = select_directml_adapter(
        str(selected["name"]),
        adapters,
        physical_identity_resolver=physical_adapter_identity,
    )
    directml = run_directml_matmul(
        ort_module,
        onnx_module,
        np_module,
        dml_device_index,
    )
    rocm_after_directml = rocm_probe.run_matmul(torch_module, selected_index)
    return {
        "schema": 1,
        "status": "ok",
        **runtime,
        "expectedGfx": rocm_probe.normalize_gfx_name(expected_gfx),
        "selectedDevice": selected,
        "devices": rocm_inventory,
        "onnxProviders": providers,
        "dxgiDevices": dxgi_inventory,
        "directml": directml,
        "rocmAfterDirectml": rocm_after_directml,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Verify Windows ROCm PyTorch and ONNX Runtime DirectML coexist in one process."
        )
    )
    parser.add_argument("--device-index", type=int)
    parser.add_argument("--expected-gfx", default=rocm_probe.DEFAULT_EXPECTED_GFX)
    args = parser.parse_args()
    try:
        print(
            json.dumps(
                probe(args.device_index, args.expected_gfx),
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    except rocm_probe.ProbeError as exc:
        print(f"[Mozarie] ROCm/DirectML probe failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
