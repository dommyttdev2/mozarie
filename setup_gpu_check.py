"""Small, quiet GPU smoke test used by setup.bat."""

from __future__ import annotations


CPU_MESSAGE = "[Mozarie] GPU unavailable. CPU will be used; change it later in Settings. / GPUは利用できません。CPUを使用します。後で設定から変更できます。"


def main() -> int:
    try:
        import numpy as np
        import onnxruntime as ort
        import torch
        from onnxruntime import datasets

        if not torch.cuda.is_available() or "CUDAExecutionProvider" not in ort.get_available_providers():
            print(CPU_MESSAGE)
            return 0
        session = ort.InferenceSession(datasets.get_example("mul_1.onnx"), providers=["CUDAExecutionProvider"])
        session.disable_fallback()
        if session.get_providers()[0] != "CUDAExecutionProvider":
            print(CPU_MESSAGE)
            return 0
        session.run(None, {"X": np.ones((3, 2), dtype=np.float32)})
    except Exception:
        print(CPU_MESSAGE)
        return 0
    print("[Mozarie] GPU is ready.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
