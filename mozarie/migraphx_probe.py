from __future__ import annotations

import argparse
from importlib import metadata
import json
from pathlib import Path
import sys
from typing import Any, Callable


EP_NAME = "MIGraphXExecutionProvider"
MIN_WINDOWS_BUILD = 26100
WINDOWSML_DISTRIBUTION = "onnxruntime-windowsml"
CONFLICTING_ORT_DISTRIBUTIONS = (
    "onnxruntime",
    "onnxruntime-gpu",
    "onnxruntime-directml",
)


class ProbeError(RuntimeError):
    pass


def validate_host(platform_name: str | None = None, build: int | None = None) -> int:
    platform_name = sys.platform if platform_name is None else platform_name
    if platform_name != "win32":
        raise ProbeError("MIGraphX Windows ML probe requires Windows.")
    if build is None:
        build = int(sys.getwindowsversion().build)
    build = int(build)
    if build < MIN_WINDOWS_BUILD:
        raise ProbeError(
            f"Windows 11 24H2 build {MIN_WINDOWS_BUILD} or newer is required; found build {build}."
        )
    return build


def installed_ort_distributions(
    version_getter: Callable[[str], str] = metadata.version,
) -> dict[str, str]:
    installed: dict[str, str] = {}
    for name in (WINDOWSML_DISTRIBUTION, *CONFLICTING_ORT_DISTRIBUTIONS):
        try:
            installed[name] = version_getter(name)
        except metadata.PackageNotFoundError:
            continue
    return installed


def validate_runtime_install(installed: dict[str, str] | None = None) -> dict[str, str]:
    installed = installed_ort_distributions() if installed is None else dict(installed)
    if WINDOWSML_DISTRIBUTION not in installed:
        raise ProbeError("onnxruntime-windowsml is not installed in the probe environment.")
    conflicts = [name for name in CONFLICTING_ORT_DISTRIBUTIONS if name in installed]
    if conflicts:
        raise ProbeError(
            "The probe environment contains conflicting ONNX Runtime distributions: "
            + ", ".join(conflicts)
            + ". Recreate the dedicated probe venv."
        )
    return installed


def repair_winrt_runtime(distribution_getter: Callable[[str], Any] = metadata.distribution) -> bool:
    """Apply Microsoft's documented Python workaround inside the dedicated probe venv."""
    try:
        distribution = distribution_getter("winrt-runtime")
    except metadata.PackageNotFoundError as exc:
        raise ProbeError("winrt-runtime is not installed in the probe environment.") from exc
    site_packages = Path(str(distribution.locate_file("")))
    conflicting_dll = site_packages / "winrt" / "msvcp140.dll"
    if not conflicting_dll.exists():
        return False
    try:
        conflicting_dll.unlink()
    except OSError as exc:
        raise ProbeError(f"Could not remove conflicting WinRT runtime DLL: {conflicting_dll}") from exc
    return True


def ensure_migraphx_provider(winml: Any) -> tuple[Any, list[dict[str, object]]]:
    catalog = winml.ExecutionProviderCatalog.get_default()
    providers = list(catalog.find_all_providers())
    inventory = [
        {
            "name": str(getattr(provider, "name", "")),
            "readyState": str(getattr(provider, "ready_state", "")),
            "libraryPath": str(getattr(provider, "library_path", "")),
        }
        for provider in providers
    ]
    selected = next((provider for provider in providers if getattr(provider, "name", None) == EP_NAME), None)
    if selected is None:
        raise ProbeError(
            f"{EP_NAME} is not available for this Windows ML device/driver combination."
        )
    result = selected.ensure_ready_async().get()
    if result.status != winml.ExecutionProviderReadyResultState.SUCCESS:
        diagnostic = str(getattr(result, "diagnostic_text", "")).strip()
        extended = str(getattr(result, "extended_error", "")).strip()
        details = "; ".join(value for value in (diagnostic, extended) if value)
        raise ProbeError(
            f"Windows ML could not prepare {EP_NAME}" + (f": {details}" if details else ".")
        )
    library_path = str(getattr(selected, "library_path", "")).strip()
    if not library_path:
        raise ProbeError(f"Windows ML prepared {EP_NAME}, but returned no plugin library path.")
    return selected, inventory


def describe_ep_device(ep_device: Any, index: int) -> dict[str, object]:
    device = getattr(ep_device, "device", None)
    return {
        "index": index,
        "epName": str(getattr(ep_device, "ep_name", "")),
        "epVendor": str(getattr(ep_device, "ep_vendor", "")),
        "device": str(device),
    }


def select_migraphx_device(ort: Any, device_index: int | None = None) -> tuple[Any, list[dict[str, object]]]:
    matches = [device for device in ort.get_ep_devices() if getattr(device, "ep_name", None) == EP_NAME]
    inventory = [describe_ep_device(device, index) for index, device in enumerate(matches)]
    if not matches:
        raise ProbeError(f"{EP_NAME} registered, but ONNX Runtime exposed no MIGraphX EP devices.")
    if device_index is None:
        if len(matches) != 1:
            raise ProbeError(
                f"{len(matches)} MIGraphX EP devices were found. Rerun with --ep-device-index after reviewing "
                f"the device inventory: {json.dumps(inventory, ensure_ascii=False)}"
            )
        return matches[0], inventory
    if device_index < 0 or device_index >= len(matches):
        raise ProbeError(f"MIGraphX EP device index {device_index} is unavailable.")
    return matches[device_index], inventory


def build_matmul_model(onnx: Any, np: Any) -> bytes:
    helper = onnx.helper
    tensor_proto = onnx.TensorProto
    input_value = helper.make_tensor_value_info("input", tensor_proto.FLOAT, [1, 64])
    output_value = helper.make_tensor_value_info("output", tensor_proto.FLOAT, [1, 64])
    weights = helper.make_tensor(
        "weights",
        tensor_proto.FLOAT,
        [64, 64],
        np.ones((64, 64), dtype=np.float32).reshape(-1).tolist(),
    )
    graph = helper.make_graph(
        [helper.make_node("MatMul", ["input", "weights"], ["output"])],
        "mozarie-migraphx-probe",
        [input_value],
        [output_value],
        [weights],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    return model.SerializeToString()


def run_migraphx_inference(ort: Any, onnx: Any, np: Any, ep_device: Any) -> dict[str, object]:
    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    options.add_provider_for_devices([ep_device], {})
    session = ort.InferenceSession(build_matmul_model(onnx, np), sess_options=options)
    disable_fallback = getattr(session, "disable_fallback", None)
    if callable(disable_fallback):
        disable_fallback()
    providers = list(session.get_providers())
    if not providers or providers[0] != EP_NAME:
        raise ProbeError(
            f"ONNX Runtime did not select {EP_NAME}; active providers: {providers or ['none']}"
        )
    output = session.run(None, {"input": np.ones((1, 64), dtype=np.float32)})
    if len(output) != 1 or not np.allclose(np.asarray(output[0]), 64.0):
        raise ProbeError("MIGraphX MatMul inference returned an unexpected result.")
    return {"providers": providers, "outputVerified": True}


def probe(device_index: int | None = None) -> dict[str, object]:
    build = validate_host()
    installed = validate_runtime_install()
    repaired = repair_winrt_runtime()
    try:
        from winui3.microsoft.windows.applicationmodel.dynamicdependency.bootstrap import (
            InitializeOptions,
            initialize,
        )
        import winui3.microsoft.windows.ai.machinelearning as winml
        import numpy as np
        import onnx
        import onnxruntime as ort
    except Exception as exc:
        raise ProbeError(f"Windows ML probe dependencies could not be imported: {exc}") from exc

    with initialize(options=InitializeOptions.ON_NO_MATCH_SHOW_UI):
        provider, windows_ml_inventory = ensure_migraphx_provider(winml)
        try:
            ort.register_execution_provider_library(provider.name, provider.library_path)
        except Exception as exc:
            raise ProbeError(f"Could not register {EP_NAME} with ONNX Runtime: {exc}") from exc
        ep_device, ep_devices = select_migraphx_device(ort, device_index)
        inference = run_migraphx_inference(ort, onnx, np, ep_device)

    return {
        "schema": 1,
        "status": "ok",
        "windowsBuild": build,
        "onnxRuntimeDistributions": installed,
        "winrtRuntimeDllRemoved": repaired,
        "windowsMlProviders": windows_ml_inventory,
        "migraphxDevices": ep_devices,
        **inference,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify Windows ML MIGraphX ONNX inference without CPU/DirectML runtime fallback."
    )
    parser.add_argument("--ep-device-index", type=int)
    args = parser.parse_args()
    try:
        print(json.dumps(probe(args.ep_device_index), ensure_ascii=False, indent=2))
        return 0
    except ProbeError as exc:
        print(f"[Mozarie] MIGraphX probe failed: {exc}", file=sys.stderr)
        return 1
