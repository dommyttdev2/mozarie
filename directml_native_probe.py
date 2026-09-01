from __future__ import annotations

import inspect
import torch_directml


def _safe_signature(value: object) -> str:
    try:
        return str(inspect.signature(value))
    except Exception as exc:
        return f"unavailable ({type(exc).__name__}: {exc})"


def _safe_source(value: object) -> str:
    try:
        return inspect.getsource(value).strip()
    except Exception as exc:
        return f"unavailable ({type(exc).__name__}: {exc})"


def main() -> int:
    native = getattr(torch_directml, "torch_directml_native", None)
    print(f"torch_directml_file={getattr(torch_directml, '__file__', None)!r}")
    print(f"native_module={native!r}")
    print(f"native_file={getattr(native, '__file__', None)!r}")

    wrappers = ("device", "default_device", "device_count", "device_name", "gpu_memory")
    for name in wrappers:
        value = getattr(torch_directml, name, None)
        print(f"wrapper_{name}_repr={value!r}")
        print(f"wrapper_{name}_signature={_safe_signature(value)!r}")
        print(f"wrapper_{name}_source={_safe_source(value)!r}")

    if native is None:
        print("native_module_missing=True")
        return 0

    names = sorted(name for name in dir(native) if not name.startswith("__"))
    print(f"native_names={names!r}")

    interesting_tokens = (
        "adapter",
        "luid",
        "device",
        "memory",
        "dml",
        "dxgi",
        "native",
        "private",
    )
    interesting = [
        name for name in names
        if any(token in name.casefold() for token in interesting_tokens)
    ]
    print(f"native_interesting_names={interesting!r}")

    for name in interesting:
        try:
            value = getattr(native, name)
        except Exception as exc:
            print(f"native_{name}_get_error={type(exc).__name__}: {exc}")
            continue
        print(f"native_{name}_repr={value!r}")
        print(f"native_{name}_type={type(value)!r}")
        print(f"native_{name}_signature={_safe_signature(value)!r}")
        print(f"native_{name}_doc={getattr(value, '__doc__', None)!r}")
        print(f"native_{name}_text_signature={getattr(value, '__text_signature__', None)!r}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
