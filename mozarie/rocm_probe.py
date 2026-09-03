from __future__ import annotations

import argparse
import json
import sys
from typing import Any


EXPECTED_TORCH_VERSION = "2.11.0+rocm7.13.0"
DEFAULT_EXPECTED_GFX = "gfx1032"


class ProbeError(RuntimeError):
    pass


def validate_host(platform_name: str | None = None) -> None:
    platform_name = sys.platform if platform_name is None else platform_name
    if platform_name != "win32":
        raise ProbeError("ROCm PyTorch probe requires Windows.")


def validate_rocm_torch(torch: Any) -> dict[str, object]:
    version = str(getattr(torch, "__version__", ""))
    hip_version = getattr(getattr(torch, "version", None), "hip", None)
    cuda_version = getattr(getattr(torch, "version", None), "cuda", None)
    if version != EXPECTED_TORCH_VERSION:
        raise ProbeError(
            f"Unexpected PyTorch version {version or 'unknown'}; expected {EXPECTED_TORCH_VERSION}."
        )
    if not hip_version:
        raise ProbeError("Installed PyTorch is not a ROCm/HIP build (torch.version.hip is empty).")
    if cuda_version:
        raise ProbeError(
            f"Installed PyTorch reports CUDA {cuda_version}; the ROCm probe refuses CUDA builds."
        )
    if not bool(torch.cuda.is_available()):
        raise ProbeError("ROCm PyTorch is installed, but torch.cuda.is_available() is false.")
    device_count = int(torch.cuda.device_count())
    if device_count < 1:
        raise ProbeError("ROCm PyTorch reported no GPU devices.")
    return {
        "torchVersion": version,
        "hipVersion": str(hip_version),
        "deviceCount": device_count,
    }


def normalize_gfx_name(value: object) -> str:
    return str(value or "").split(":", 1)[0].strip().lower()


def describe_device(torch: Any, index: int) -> dict[str, object]:
    props = torch.cuda.get_device_properties(index)
    arch_raw = getattr(props, "gcnArchName", "")
    return {
        "index": index,
        "name": str(torch.cuda.get_device_name(index)),
        "gfx": normalize_gfx_name(arch_raw),
        "gcnArchName": str(arch_raw),
        "totalMemoryBytes": int(getattr(props, "total_memory", 0)),
    }


def select_device(
    torch: Any,
    device_index: int | None = None,
    expected_gfx: str = DEFAULT_EXPECTED_GFX,
) -> tuple[int, list[dict[str, object]]]:
    expected = normalize_gfx_name(expected_gfx)
    inventory = [describe_device(torch, index) for index in range(int(torch.cuda.device_count()))]
    if not expected:
        raise ProbeError("Expected gfx architecture must not be empty.")

    if device_index is not None:
        if device_index < 0 or device_index >= len(inventory):
            raise ProbeError(f"ROCm device index {device_index} is unavailable.")
        selected = inventory[device_index]
        if selected["gfx"] != expected:
            raise ProbeError(
                f"ROCm device index {device_index} is {selected['gfx'] or 'unknown'}, expected {expected}."
            )
        return device_index, inventory

    matches = [item for item in inventory if item["gfx"] == expected]
    if not matches:
        raise ProbeError(
            f"No ROCm device matched {expected}. Device inventory: "
            f"{json.dumps(inventory, ensure_ascii=False)}"
        )
    if len(matches) != 1:
        raise ProbeError(
            f"{len(matches)} ROCm devices matched {expected}. Rerun with --device-index after reviewing "
            f"the device inventory: {json.dumps(inventory, ensure_ascii=False)}"
        )
    return int(matches[0]["index"]), inventory


def _assert_allclose(torch: Any, actual: Any, expected: Any, label: str) -> None:
    if not bool(torch.allclose(actual, expected)):
        raise ProbeError(f"ROCm {label} returned an unexpected result.")


def run_matmul(torch: Any, device_index: int) -> dict[str, object]:
    device = torch.device(f"cuda:{device_index}")
    left = torch.ones((64, 64), dtype=torch.float32, device="cpu").to(device)
    right = torch.ones((64, 64), dtype=torch.float32, device="cpu").to(device)
    output = left @ right
    torch.cuda.synchronize(device)
    output_cpu = output.cpu()
    expected = torch.full((64, 64), 64.0, dtype=torch.float32, device="cpu")
    _assert_allclose(torch, output_cpu, expected, "MatMul")
    return {
        "shape": list(output_cpu.shape),
        "verified": True,
    }


def run_conv2d(torch: Any, device_index: int) -> dict[str, object]:
    device = torch.device(f"cuda:{device_index}")
    image = torch.ones((1, 1, 8, 8), dtype=torch.float32, device="cpu").to(device)
    kernel = torch.ones((1, 1, 3, 3), dtype=torch.float32, device="cpu").to(device)
    output = torch.nn.functional.conv2d(image, kernel)
    torch.cuda.synchronize(device)
    output_cpu = output.cpu()
    expected = torch.full((1, 1, 6, 6), 9.0, dtype=torch.float32, device="cpu")
    _assert_allclose(torch, output_cpu, expected, "Conv2d")
    return {
        "shape": list(output_cpu.shape),
        "verified": True,
    }


def probe(
    device_index: int | None = None,
    expected_gfx: str = DEFAULT_EXPECTED_GFX,
    torch_module: Any | None = None,
) -> dict[str, object]:
    validate_host()
    if torch_module is None:
        try:
            import torch as torch_module
        except Exception as exc:
            raise ProbeError(f"ROCm PyTorch could not be imported: {exc}") from exc

    runtime = validate_rocm_torch(torch_module)
    selected_index, inventory = select_device(torch_module, device_index, expected_gfx)
    torch_module.cuda.set_device(selected_index)
    selected = inventory[selected_index]
    matmul = run_matmul(torch_module, selected_index)
    conv2d = run_conv2d(torch_module, selected_index)
    return {
        "schema": 1,
        "status": "ok",
        **runtime,
        "expectedGfx": normalize_gfx_name(expected_gfx),
        "selectedDevice": selected,
        "devices": inventory,
        "matmul": matmul,
        "conv2d": conv2d,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify Windows PyTorch ROCm/HIP execution without DirectML or CPU fallback."
    )
    parser.add_argument("--device-index", type=int)
    parser.add_argument("--expected-gfx", default=DEFAULT_EXPECTED_GFX)
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
    except ProbeError as exc:
        print(f"[Mozarie] ROCm probe failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
