from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from . import rocm_probe


DEFAULT_IMAGE_SIZE = 64
MODEL_TYPE = "vit_b"


def _shape(value: Any) -> list[int]:
    return [int(item) for item in value.shape]


def validate_sam_outputs(
    np: Any,
    masks: Any,
    scores: Any,
    logits: Any,
    *,
    image_size: int,
) -> dict[str, object]:
    expected_mask_shape = [1, image_size, image_size]
    mask_shape = _shape(masks)
    if mask_shape != expected_mask_shape:
        raise rocm_probe.ProbeError(
            f"SAM returned mask shape {mask_shape}, expected {expected_mask_shape}."
        )
    score_shape = _shape(scores)
    if score_shape != [1]:
        raise rocm_probe.ProbeError(f"SAM returned score shape {score_shape}, expected [1].")
    logits_shape = _shape(logits)
    if len(logits_shape) != 3 or logits_shape[0] != 1:
        raise rocm_probe.ProbeError(f"SAM returned unexpected logits shape {logits_shape}.")
    if not bool(np.isfinite(scores).all()):
        raise rocm_probe.ProbeError("SAM returned a non-finite score.")
    if not bool(np.isfinite(logits).all()):
        raise rocm_probe.ProbeError("SAM returned non-finite mask logits.")
    return {
        "maskShape": expected_mask_shape,
        "scoreShape": [1],
        "logitsShape": logits_shape,
        "finite": True,
    }


def run_sam_vit_b(
    torch: Any,
    np: Any,
    sam_predictor_type: Any,
    sam_model_registry: Any,
    device_index: int,
    *,
    image_size: int = DEFAULT_IMAGE_SIZE,
) -> dict[str, object]:
    device = torch.device(f"cuda:{device_index}")
    predictor = None
    try:
        with torch.inference_mode():
            model = sam_model_registry[MODEL_TYPE](checkpoint=None)
            model.to(device=device)
            parameter_device = str(next(model.parameters()).device)
            expected_device = str(device)
            if parameter_device != expected_device:
                raise rocm_probe.ProbeError(
                    f"SAM model is on {parameter_device}, expected {expected_device}."
                )
            predictor = sam_predictor_type(model)
            image = np.zeros((image_size, image_size, 3), dtype=np.uint8)
            center = image_size // 2
            predictor.set_image(image)
            feature_device = str(predictor.features.device)
            if feature_device != expected_device:
                raise rocm_probe.ProbeError(
                    f"SAM image embedding is on {feature_device}, expected {expected_device}."
                )
            masks, scores, logits = predictor.predict(
                point_coords=np.asarray([[center, center]], dtype=np.float32),
                point_labels=np.asarray([1], dtype=np.int32),
                multimask_output=False,
            )
            torch.cuda.synchronize(device)
            output = validate_sam_outputs(
                np,
                masks,
                scores,
                logits,
                image_size=image_size,
            )
            return {
                "modelType": MODEL_TYPE,
                "device": expected_device,
                "inputImageShape": [image_size, image_size, 3],
                **output,
            }
    finally:
        if predictor is not None:
            predictor.reset_image()
        torch.cuda.empty_cache()


def probe(
    device_index: int | None = None,
    expected_gfx: str = rocm_probe.DEFAULT_EXPECTED_GFX,
    *,
    torch_module: Any | None = None,
    np_module: Any | None = None,
    sam_predictor_type: Any | None = None,
    sam_model_registry: Any | None = None,
) -> dict[str, object]:
    rocm_probe.validate_host()
    if torch_module is None or np_module is None or sam_predictor_type is None or sam_model_registry is None:
        try:
            if torch_module is None:
                import torch as torch_module
            if np_module is None:
                import numpy as np_module
            if sam_predictor_type is None or sam_model_registry is None:
                from segment_anything import SamPredictor, sam_model_registry as registry
                if sam_predictor_type is None:
                    sam_predictor_type = SamPredictor
                if sam_model_registry is None:
                    sam_model_registry = registry
        except Exception as exc:
            raise rocm_probe.ProbeError(f"ROCm SAM probe dependencies could not be imported: {exc}") from exc

    runtime = rocm_probe.validate_rocm_torch(torch_module)
    selected_index, inventory = rocm_probe.select_device(
        torch_module,
        device_index,
        expected_gfx,
    )
    torch_module.cuda.set_device(selected_index)
    sam = run_sam_vit_b(
        torch_module,
        np_module,
        sam_predictor_type,
        sam_model_registry,
        selected_index,
    )
    return {
        "schema": 1,
        "status": "ok",
        **runtime,
        "expectedGfx": rocm_probe.normalize_gfx_name(expected_gfx),
        "selectedDevice": inventory[selected_index],
        "devices": inventory,
        "sam": sam,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify Segment Anything ViT-B inference on Windows PyTorch ROCm/HIP."
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
        print(f"[Mozarie] ROCm SAM probe failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
