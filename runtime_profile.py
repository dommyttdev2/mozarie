from __future__ import annotations

import argparse
from importlib import metadata
import json
import os
from pathlib import Path
import sys


PROFILES = {"cuda", "directml", "cpu"}
RUNTIME_DISTRIBUTIONS = {
    "onnxruntime": "cpu",
    "onnxruntime-gpu": "cuda",
    "onnxruntime-directml": "directml",
}
MARKER_NAME = ".mozarie-runtime.json"


class ProfileError(RuntimeError):
    pass


def normalize_profile(value: str | None) -> str | None:
    profile = (value or "").strip().lower()
    if not profile:
        return None
    if profile not in PROFILES:
        raise ProfileError(f"Unknown MOZARIE_RUNTIME value: {value!r}. Use cuda, directml, or cpu.")
    return profile


def marker_path(venv: Path) -> Path:
    return venv / MARKER_NAME


def read_marker(venv: Path) -> dict[str, object] | None:
    path = marker_path(venv)
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def installed_distributions() -> dict[str, str]:
    installed: dict[str, str] = {}
    for distribution, profile in RUNTIME_DISTRIBUTIONS.items():
        try:
            installed[distribution] = metadata.version(distribution)
        except metadata.PackageNotFoundError:
            continue
    return installed


def installed_profile() -> str | None:
    profiles = {RUNTIME_DISTRIBUTIONS[name] for name in installed_distributions()}
    if len(profiles) > 1:
        raise ProfileError(
            "Multiple ONNX Runtime variants are installed. Back up and recreate .venv; "
            "CPU, CUDA, and DirectML variants must not share one environment."
        )
    return next(iter(profiles), None)


def preflight(profile: str) -> None:
    requested = normalize_profile(profile)
    assert requested is not None
    current = installed_profile()
    if current is not None and requested != current:
        raise ProfileError(
            f"The existing environment is {current}, but setup selected {requested}. "
            "The environment was not changed. Back up or remove .venv before changing runtimes."
        )
    if current is None:
        return
    try:
        import onnxruntime as ort
    except Exception as exc:
        raise ProfileError(f"The existing ONNX Runtime cannot be imported: {exc}") from exc
    providers = set(ort.get_available_providers())
    expected = {
        "cuda": "CUDAExecutionProvider",
        "directml": "DmlExecutionProvider",
        "cpu": "CPUExecutionProvider",
    }[current]
    if expected not in providers:
        raise ProfileError(
            f"The installed {current} distribution does not expose {expected}. "
            "The environment is inconsistent; back up and recreate .venv."
        )


def validate(profile: str) -> dict[str, object]:
    selected = normalize_profile(profile)
    assert selected is not None
    current = installed_profile()
    if current != selected:
        raise ProfileError(
            f"The installed ONNX Runtime profile is {current or 'missing'}, not {selected}."
        )
    try:
        import onnxruntime as ort
        import torch
    except Exception as exc:
        raise ProfileError(f"Runtime packages cannot be imported: {exc}") from exc

    providers = list(ort.get_available_providers())
    devices: list[str] = []
    if selected == "cuda":
        if not getattr(torch.version, "cuda", None) or "CUDAExecutionProvider" not in providers:
            raise ProfileError("CUDA PyTorch or CUDAExecutionProvider is unavailable.")
        if not torch.cuda.is_available():
            raise ProfileError("CUDA packages are installed, but no usable NVIDIA CUDA device was found.")
        devices = [torch.cuda.get_device_name(index) for index in range(torch.cuda.device_count())]
        probe = torch.ones(1, device="cuda:0") + 1
        if float(probe.cpu().item()) != 2.0:
            raise ProfileError("The CUDA tensor probe failed.")
    elif selected == "directml":
        if "DmlExecutionProvider" not in providers:
            raise ProfileError("onnxruntime-directml is installed, but DmlExecutionProvider is unavailable.")
        try:
            import torch_directml
        except Exception as exc:
            raise ProfileError(f"torch-directml cannot be imported: {exc}") from exc
        count = int(torch_directml.device_count())
        if count < 1:
            raise ProfileError("torch-directml did not find a DirectML device.")
        devices = [str(torch_directml.device_name(index)).rstrip("\0") for index in range(count)]
        device = torch_directml.device(torch_directml.default_device())
        probe = torch.ones(1, device=device) + 1
        if float(probe.cpu().item()) != 2.0:
            raise ProfileError("The DirectML tensor probe failed.")
    else:
        if "CPUExecutionProvider" not in providers:
            raise ProfileError("CPUExecutionProvider is unavailable.")
        probe = torch.ones(1) + 1
        if float(probe.item()) != 2.0:
            raise ProfileError("The CPU tensor probe failed.")

    return {
        "schema": 1,
        "profile": selected,
        "python": sys.version.split()[0],
        "providers": providers,
        "devices": devices,
    }


def write_marker(venv: Path, result: dict[str, object]) -> None:
    path = marker_path(venv)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def selected_profile(venv: Path) -> str | None:
    explicit = normalize_profile(os.environ.get("MOZARIE_RUNTIME"))
    if explicit is not None:
        return explicit
    marker = read_marker(venv)
    if marker is not None:
        return normalize_profile(str(marker.get("profile", "")))
    return installed_profile()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("show", "preflight", "validate"))
    parser.add_argument("profile", nargs="?")
    parser.add_argument("--venv", type=Path, default=Path(__file__).resolve().parent / ".venv")
    parser.add_argument("--write-marker", action="store_true")
    args = parser.parse_args()
    try:
        if args.command == "show":
            profile = selected_profile(args.venv)
            if profile is not None:
                print(profile)
            return 0
        if args.profile is None:
            raise ProfileError("A runtime profile is required.")
        if args.command == "preflight":
            preflight(args.profile)
            return 0
        result = validate(args.profile)
        if args.write_marker:
            write_marker(args.venv, result)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except ProfileError as exc:
        print(f"[Mozarie] {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
