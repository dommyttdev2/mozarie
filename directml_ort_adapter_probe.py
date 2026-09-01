"""Diagnostic probe for ambiguous ONNX Runtime DirectML adapter identities.

This script intentionally does not participate in Mozarie's device mapping. It runs
small ONNX Runtime workloads against explicitly requested DXGI/ORT device ids and
samples torch-directml memory telemetry around each run so ambiguous adapters can
be investigated without adding a fallback to production mapping.
"""

from __future__ import annotations

import argparse
import gc
import json
import time


def _memory(torch_directml, device: int):
    try:
        return list(torch_directml.gpu_memory(device))
    except Exception as exc:
        return f"unavailable ({type(exc).__name__}: {exc})"


def _snapshot(torch_directml):
    return {
        str(i): {
            "name": str(torch_directml.device_name(i)).rstrip("\0"),
            "gpu_memory": _memory(torch_directml, i),
        }
        for i in range(int(torch_directml.device_count()))
    }


def _run_ort(device_id: int, iterations: int, matrix_size: int):
    import numpy as np
    import onnxruntime as ort
    from onnxruntime import datasets

    session = ort.InferenceSession(
        datasets.get_example("mul_1.onnx"),
        providers=[("DmlExecutionProvider", {"device_id": str(device_id)})],
    )
    session.disable_fallback()
    providers = session.get_providers()
    provider_options = session.get_provider_options()
    if not providers or providers[0] != "DmlExecutionProvider":
        raise RuntimeError(f"DML provider was not selected: {providers!r}")

    # Keep the official ORT sample model as the correctness probe. Repeating it
    # makes adapter activity easier to observe while avoiding any Mozarie model.
    x = np.ones((3, 2), dtype=np.float32)
    started = time.perf_counter()
    output = None
    for _ in range(iterations):
        output = session.run(None, {"X": x})
    elapsed = time.perf_counter() - started
    return session, {
        "providers": providers,
        "provider_options": provider_options,
        "iterations": iterations,
        "elapsed_seconds": elapsed,
        "output": [value.tolist() for value in output] if output is not None else None,
        "matrix_size_ignored": matrix_size,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("device_ids", nargs="*", type=int, default=[0, 2])
    parser.add_argument("--iterations", type=int, default=2000)
    parser.add_argument("--matrix-size", type=int, default=0,
                        help="Reserved for a future heavier probe; currently ignored.")
    parser.add_argument("--settle", type=float, default=0.5)
    args = parser.parse_args()

    import torch_directml

    print("torch_directml_before=" + json.dumps(_snapshot(torch_directml), ensure_ascii=False))
    for device_id in args.device_ids:
        print(f"=== ORT DML device_id={device_id} ===")
        before = _snapshot(torch_directml)
        print("before=" + json.dumps(before, ensure_ascii=False))
        session = None
        try:
            session, result = _run_ort(device_id, args.iterations, args.matrix_size)
            during = _snapshot(torch_directml)
            print("ort=" + json.dumps(result, ensure_ascii=False))
            print("during=" + json.dumps(during, ensure_ascii=False))
        except Exception as exc:
            print(f"error={type(exc).__name__}: {exc}")
        finally:
            del session
            gc.collect()
            time.sleep(args.settle)
        after = _snapshot(torch_directml)
        print("after=" + json.dumps(after, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
