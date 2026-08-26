from __future__ import annotations

import os
import uuid
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageOps

from .core import (
    DEFAULT_COLORS, DEFAULT_DETECTION_CONFIDENCE, HAND_CONFIDENCE,
    REFINEMENT_LABELS, SOURCE_LABELS, TARGET_CLASSES, Candidate, CandidateRole,
    ClientError, ImageRecord, JobControl, accepted_hand_sam_mask,
    accepted_specialist_hand_mask, arbitrate_segment_sources, clip_mask_to_roi,
    confidence_for_source, detection_tiles, materialize_tile_mask,
    merge_tile_segment, padded_hand_box, read_boundary_request,
    read_polygon_boundary_request, sam_refinement_prompts,
    select_best_sam_mask, select_semantic_sam_mask, white_fluid_mask,
    _read_detection_parallelism, _read_target_classes,
)
from .inference.generic_yolo_segment import GenericYoloSegmenter
from .inference.yolo_detect import HandDetector
from .inference.yolo_segment import TargetSegmenter
from .runtime_types import DetectionModels

class DetectionMixin:
    def start_detection(
        self,
        image_ids: list[str],
        confidence: float = DEFAULT_DETECTION_CONFIDENCE,
        parallelism: int = 2,
        target_classes: set[str] | None = None,
    ) -> None:
        # The gate makes initial job setup mutually exclusive with boundary
        # inference and model-cache replacement.
        with self.inference_lock:
            self._require_supported_gpu()
            records, catalog_generation = self._records_for_ids_with_catalog(image_ids)
            targets = _read_target_classes(target_classes or set(self.settings["detection"]["targets"]))
            args: tuple[Any, ...] = (confidence, _read_detection_parallelism(parallelism))
            if targets != TARGET_CLASSES:
                args = (*args, targets)
            self._start_job("detect", records, self._detect_worker, *args, expected_catalog_generation=catalog_generation)


    def _load_detection_models(self) -> DetectionModels:
        model_path = self._configured_model_path("target_segmentation", "対象セグメンテーション")
        provider = str(self.settings["models"].get("provider", "gpu"))
        gpu_device = int(self.settings["models"].get("gpu_device", 0))
        target = TargetSegmenter(model_path, device=provider, gpu_device=gpu_device)
        auxiliaries: list[tuple[str, GenericYoloSegmenter]] = []
        for key, label in (("ntd11", "NTD11補助モデル"), ("sensitive", "Sensitive補助モデル")):
            if not self.settings["models"][f"{key}_enabled"]:
                continue
            auxiliaries.append((key, GenericYoloSegmenter(self._configured_model_path(key, label), device=provider, gpu_device=gpu_device)))
        return DetectionModels(target=target, auxiliaries=auxiliaries)

    def _configured_model_path(self, key: str, label: str) -> Path:
        raw_path = str(self.settings.get("models", {}).get(key, "")).strip()
        if not raw_path:
            raise ClientError(f"{label}モデルが未設定です。設定のモデルタブでONNXファイルを指定してください。")
        path = Path(raw_path).expanduser()
        if not path.is_file():
            raise ClientError(f"{label}モデルが見つかりません: {path}")
        if path.suffix.lower() != ".onnx":
            raise ClientError(f"{label}モデルにはONNXファイルを指定してください。")
        return path

    def _configured_sam_path(self) -> Path:
        models = self.settings.get("models", {})
        raw_path = str(models.get("sam_checkpoints", {}).get(models.get("sam_model_type"), "")).strip()
        if not raw_path:
            raise ClientError("SAMモデルが未設定です。設定のモデルタブでチェックポイントを指定してください。")
        path = Path(raw_path).expanduser()
        if not path.is_file():
            raise ClientError(f"SAMモデルが見つかりません: {path}")
        if path.suffix.lower() not in {".pth", ".pt", ".ckpt"}:
            raise ClientError("SAMチェックポイントは .pth、.pt、.ckpt のいずれかを指定してください。", "sam_checkpoint_invalid")
        return path

    def _ensure_models(self) -> DetectionModels:
        with self.lock:
            if self.models is not None:
                return self.models
        self._set_detection_model_preparation(True)
        try:
            models = self._load_detection_models()
        finally:
            self._set_detection_model_preparation(False)
        with self.lock:
            self.models = models
        return models

    def _ensure_hand_model(self, models: DetectionModels | None = None) -> HandDetector:
        with self.inference_lock:
            with self.lock:
                hand = self.hand_model
            if hand is None:
                self._set_detection_model_preparation(True)
                try:
                    model_path = self._configured_model_path("hand_detection", "手の検出")
                    provider = str(self.settings["models"].get("provider", "gpu"))
                    hand = HandDetector(model_path, device=provider, gpu_device=int(self.settings["models"].get("gpu_device", 0)))
                finally:
                    self._set_detection_model_preparation(False)
                with self.lock:
                    self.hand_model = hand
            if models is not None:
                models.hand = hand
            return hand

    def _boundary_hand_boxes(self, rgb: np.ndarray) -> list[tuple[int, int, int, int]]:
        """Load only the hand detector for an interactive boundary request."""
        if not self.settings["models"]["hand_detection_enabled"]:
            return []
        return self._ensure_hand_model().detect_boxes(rgb, HAND_CONFIDENCE)

    def _detect_worker(
        self,
        records: list[ImageRecord],
        confidence: float,
        parallelism: int = 2,
        target_classes: set[str] | None = None,
        *,
        control: JobControl | None = None,
        job_generation: int | None = None,
        catalog_generation: int | None = None,
    ) -> None:
        models: DetectionModels | None = None
        try:
            mode = str(self.settings["detection"]["mode"])
            requested_parallelism = _read_detection_parallelism(parallelism)
            worker_count = min(requested_parallelism, len(records))
            self._set_job_parallelism(worker_count, job_generation, catalog_generation)
            self._wait_while_paused(control, job_generation, catalog_generation)
            if control is not None and (control.cancel_requested.is_set() or control.failed.is_set()):
                self._cancel_job(job_generation, catalog_generation)
                return
            if not self._job_is_current(job_generation, catalog_generation):
                return
            models = self._ensure_models()

            def claim_and_run(index: int, record: ImageRecord) -> None:
                try:
                    self._set_job_current(record.relative_path, job_generation, catalog_generation)
                    candidates = self._detect_image(models, record, confidence, mode, target_classes or TARGET_CLASSES)
                    if control is not None and (control.cancel_requested.is_set() or control.failed.is_set()):
                        self._discard_candidates(candidates)
                        return
                    try:
                        image_lock = self.image_io_lock(record.image_id)
                    except ClientError:
                        self._discard_candidates(candidates)
                        raise
                    with image_lock:
                        try:
                            self._assert_record_stat_matches(record)
                        except ClientError:
                            self._discard_candidates(candidates)
                            raise
                        with self.lock:
                            if ((control is not None and (control.cancel_requested.is_set() or control.failed.is_set()))
                                    or not self._job_is_current(job_generation, catalog_generation)
                                    or self.images.get(record.image_id) is not record):
                                self._discard_candidates(candidates)
                                return
                            boundary_candidates = [candidate for candidate in self.candidates.get(record.image_id, []) if candidate.origin == "boundary"]
                            stale_paths = [candidate.mask_path for candidate in self.candidates.get(record.image_id, []) if candidate.origin != "boundary"]
                        try:
                            for candidate in candidates:
                                final_path = self.cache_dir / record.image_id / f"{candidate.candidate_id}.png"
                                if candidate.mask_path.name.startswith(".mozarie-pending-"):
                                    os.replace(candidate.mask_path, final_path)
                                    candidate.mask_path = final_path
                        except Exception:
                            self._discard_candidates(candidates)
                            raise
                        with self.lock:
                            if ((control is not None and (control.cancel_requested.is_set() or control.failed.is_set()))
                                    or not self._job_is_current(job_generation, catalog_generation)
                                    or self.images.get(record.image_id) is not record):
                                self._discard_candidates(candidates)
                                return
                            self.candidates[record.image_id] = [*boundary_candidates, *candidates]
                            self._touch_candidates(record.image_id)
                            self._persist_candidates(record.image_id)
                            self._record_job_success(index, record.image_id, None, job_generation, catalog_generation)
                        for path in stale_paths:
                            path.unlink(missing_ok=True)
                    self._set_job_current(record.relative_path, job_generation, catalog_generation)
                finally:
                    self.invalidate_sam_image(record.image_id)

            failures = self._run_fixed_workers(records, worker_count, claim_and_run, control, job_generation, catalog_generation)
            if failures:
                # ``claim_and_run`` closes over this variable. Clear the final
                # Python reference before OOM recovery drops state-owned models.
                if self._is_gpu_out_of_memory(failures[0][1]):
                    models = None
                self._fail_job(failures[0][1], job_generation, catalog_generation)
                return
            if control is not None and control.cancel_requested.is_set():
                self._cancel_job(job_generation, catalog_generation)
                return
            self._finish_job(job_generation, catalog_generation)
        except Exception as exc:  # A background job must not kill the HTTP server.
            models = None
            self._fail_job(exc, job_generation, catalog_generation)

    def _discard_candidates(self, candidates: list[Candidate]) -> None:
        for candidate in candidates:
            candidate.mask_path.unlink(missing_ok=True)

    def _detect_arbitrated_segments(
        self, models: DetectionModels, rgb: np.ndarray, confidence: float, target_classes: set[str] | None = None
    ) -> list[dict[str, Any]]:
        rgb = np.asarray(rgb)
        height, width = rgb.shape[:2]
        targets = target_classes or TARGET_CLASSES
        segments = (models.target.detect(rgb, confidence) if targets == TARGET_CLASSES
                    else models.target.detect(rgb, confidence, targets))
        collected = [segment for segment in segments if segment["mask"].shape == (height, width)]
        for source, model in models.auxiliaries:
            tiled_segments: list[dict[str, Any]] = []
            for x_offset, y_offset, tile_width, tile_height in detection_tiles(width, height):
                tile = rgb[y_offset:y_offset + tile_height, x_offset:x_offset + tile_width]
                if targets == TARGET_CLASSES:
                    detected_segments = model.detect(tile, confidence_for_source(source, confidence), source)
                else:
                    detected_segments = model.detect(tile, confidence_for_source(source, confidence), source, targets)
                for segment in detected_segments:
                    local_mask = np.asarray(segment["mask"], dtype=np.uint8)
                    if local_mask.shape != (tile_height, tile_width):
                        continue
                    merge_tile_segment(
                        tiled_segments,
                        str(segment["class_name"]),
                        float(segment["confidence"]),
                        local_mask,
                        x_offset,
                        y_offset,
                        source,
                    )
            collected.extend(materialize_tile_mask(segment, width, height) for segment in tiled_segments)
        return arbitrate_segment_sources(collected)

    def _hand_boxes(self, models: DetectionModels, rgb: np.ndarray) -> list[tuple[int, int, int, int]]:
        if not self.settings["models"]["hand_detection_enabled"]:
            return []
        hand_model = self._ensure_hand_model(models)
        return hand_model.detect_boxes(rgb, HAND_CONFIDENCE)

    def _hand_refinement_context(
        self, models: DetectionModels, record: ImageRecord, rgb: np.ndarray, segments: list[dict[str, Any]]
    ) -> tuple[list[dict[str, Any]], np.ndarray, list[tuple[int, int, int, int]]]:
        """Gather all non-SAM hand evidence before the single SAM section."""
        rgb = np.asarray(rgb)
        detected = [segment for segment in segments if segment["class_name"] in TARGET_CLASSES]
        shape = rgb.shape[:2]
        hand_mask = np.zeros(shape, dtype=np.uint8)
        fallback_boxes: list[tuple[int, int, int, int]] = []
        hand_boxes = self._hand_boxes(models, rgb)
        if hand_boxes:
            fallback_boxes = [box for box in (padded_hand_box(box, shape) for box in hand_boxes) if box is not None]
            if self.settings["models"].get("hand_segmentation_enabled"):
                with self.hand_segmentation_lock:
                    specialist_predictor = self._hand_segmentation_predictor_for(record, rgb)
                    for padded_box in fallback_boxes:
                        masks, _scores, _ = specialist_predictor.predict(
                            point_coords=None, point_labels=None, box=np.asarray(padded_box, dtype=np.float32), multimask_output=False,
                        )
                        confirmed = accepted_specialist_hand_mask(masks, shape, padded_box)
                        if confirmed is not None:
                            hand_mask = np.maximum(hand_mask, confirmed)
                # HandSegNet is authoritative when enabled: rejected specialist
                # masks are dropped rather than silently changing to SAM output.
                fallback_boxes = []
        return detected, hand_mask, fallback_boxes

    @staticmethod
    def _attach_hand_evidence(segments: list[dict[str, Any]], detected: list[dict[str, Any]], hand_mask: np.ndarray) -> list[dict[str, Any]]:
        for segment in detected:
            segment["_detector_mask"] = np.asarray(segment["mask"]).copy()
            segment["_confirmed_hand"] = hand_mask
        if np.any(hand_mask):
            if detected:
                detected[0]["image_exclusions"] = {"hand": hand_mask}
            else:
                segments.append({"class_name": "__hand_exclusion__", "image_exclusions": {"hand": hand_mask}})
        return segments

    @staticmethod
    def _apply_sam_hand_fallback(
        predictor: Any, fallback_boxes: list[tuple[int, int, int, int]], shape: tuple[int, int], hand_mask: np.ndarray,
    ) -> np.ndarray:
        for padded_box in fallback_boxes:
            masks, scores, _ = predictor.predict(
                point_coords=None, point_labels=None, box=np.asarray(padded_box, dtype=np.float32), multimask_output=True,
            )
            confirmed = accepted_hand_sam_mask(masks, scores, shape, padded_box)
            if confirmed is not None:
                hand_mask = np.maximum(hand_mask, confirmed)
        return hand_mask

    def _refine_detected_segments(
        self, models: DetectionModels, record: ImageRecord, rgb: np.ndarray, segments: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Collect hand evidence before optional outline refinement.

        This stage deliberately does not change APPLY masks: SAM finalizes them
        first, then the same hand evidence is published as an EXCLUDE mask.
        """
        detected, hand_mask, fallback_boxes = self._hand_refinement_context(models, record, rgb, segments)
        if fallback_boxes:
            with self.sam_lock:
                predictor = self._sam_predictor_for(record, rgb)
                hand_mask = self._apply_sam_hand_fallback(predictor, fallback_boxes, np.asarray(rgb).shape[:2], hand_mask)
        return self._attach_hand_evidence(segments, detected, hand_mask)

    def _finalize_exclusions(self, rgb: np.ndarray, segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Create reviewable non-hand exclusions from the final APPLY mask."""
        for segment in segments:
            if segment.get("class_name") not in TARGET_CLASSES:
                continue
            final_mask = np.asarray(segment["mask"] > 0, dtype=np.uint8)
            exclusions: dict[str, np.ndarray] = {}
            if segment["class_name"] == "penis" and self.settings["detection"]["fluid_exclusion_enabled"]:
                fluid_mask = white_fluid_mask(rgb, final_mask)
                if np.any(fluid_mask):
                    exclusions["fluid"] = fluid_mask
            segment["exclusions"] = exclusions
        return segments

    def _high_precision_segments(
        self, models: DetectionModels, record: ImageRecord, rgb: np.ndarray, segments: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Keep target regions only when semantic SAM refinement succeeds."""
        if not any(segment.get("class_name") in TARGET_CLASSES for segment in segments):
            return segments
        with self.sam_lock:
            predictor = self._sam_predictor_for(record, rgb)
            return self._high_precision_segments_with_predictor(rgb, segments, predictor)

    def _high_precision_segments_with_predictor(
        self, rgb: np.ndarray, segments: list[dict[str, Any]], predictor: Any,
    ) -> list[dict[str, Any]]:
        refined_segments: list[dict[str, Any]] = []
        for segment in segments:
            if segment.get("class_name") not in TARGET_CLASSES:
                refined_segments.append(segment)
                continue
            source_mask = (np.asarray(segment.get("_detector_mask", segment["mask"])) > 0).astype(np.uint8)
            hand_mask = np.asarray(segment.get("_confirmed_hand", np.zeros_like(source_mask)) > 0, dtype=np.uint8)
            coordinates = np.argwhere(source_mask > 0)
            if not len(coordinates):
                continue
            top, left = coordinates.min(axis=0)
            bottom, right = coordinates.max(axis=0) + 1
            height, width = source_mask.shape
            padding = max(2, int(max(bottom - top, right - left) * 0.05))
            roi = (max(0, int(left - padding)), max(0, int(top - padding)),
                   min(width, int(right + padding)), min(height, int(bottom + padding)))
            prompt_points, labels = sam_refinement_prompts(source_mask, hand_mask)
            if not len(prompt_points):
                continue
            masks, scores, logits = predictor.predict(
                point_coords=prompt_points,
                point_labels=labels,
                box=np.asarray(roi, dtype=np.float32),
                multimask_output=True,
            )
            clipped_masks = np.asarray([clip_mask_to_roi(mask, roi) for mask in masks])
            selected = select_semantic_sam_mask(clipped_masks, scores, source_mask, hand_mask, prompt_points, labels)
            if selected is None:
                continue
            refined, selected_index = selected
            hand_overlap = int(np.count_nonzero((refined > 0) & (hand_mask > 0)))
            if hand_overlap and logits is not None and len(logits) > selected_index:
                retry_masks, retry_scores, _ = predictor.predict(
                    point_coords=prompt_points, point_labels=labels, box=np.asarray(roi, dtype=np.float32),
                    mask_input=np.asarray(logits[selected_index:selected_index + 1]), multimask_output=False,
                )
                retry = select_semantic_sam_mask(np.asarray([clip_mask_to_roi(mask, roi) for mask in retry_masks]), retry_scores, source_mask, hand_mask, prompt_points, labels)
                if retry is not None:
                    retry_mask = retry[0]
                    retry_hand = int(np.count_nonzero((retry_mask > 0) & (hand_mask > 0)))
                    source_area = max(1, int(np.count_nonzero(source_mask)))
                    retained = int(np.count_nonzero((refined > 0) & (source_mask > 0))) / source_area
                    retry_retained = int(np.count_nonzero((retry_mask > 0) & (source_mask > 0))) / source_area
                    if retry_hand < hand_overlap and retry_retained >= retained and retry_retained >= 0.50:
                        refined = retry_mask
            segment["mask"] = refined
            segment["_apply_mask"] = refined
            segment["refinement"] = "sam_high_precision"
            refined_segments.append(segment)
        return refined_segments

    def _detect_image(
        self, models: DetectionModels, record: ImageRecord, confidence: float, mode: str | None = None,
        target_classes: set[str] | None = None,
    ) -> list[Candidate]:
        # Decode is a short per-image phase. Do not hold the image
        # lock while detector/SAM inference runs.
        with self.image_io_lock(record.image_id):
            self._assert_record_stat_matches(record)
            with Image.open(record.path) as image:
                rgb = np.asarray(ImageOps.exif_transpose(image).convert("RGB")).copy()
        segments = self._detect_arbitrated_segments(models, rgb, confidence, target_classes or TARGET_CLASSES)
        detected, hand_mask, fallback_boxes = self._hand_refinement_context(models, record, rgb, segments)
        needs_high_precision = mode == "high_precision" and bool(detected)
        if fallback_boxes or needs_high_precision:
            with self.sam_lock:
                predictor = self._sam_predictor_for(record, rgb)
                if fallback_boxes:
                    hand_mask = self._apply_sam_hand_fallback(predictor, fallback_boxes, rgb.shape[:2], hand_mask)
                segments = self._attach_hand_evidence(segments, detected, hand_mask)
                if needs_high_precision:
                    segments = self._high_precision_segments_with_predictor(rgb, segments, predictor)
        else:
            segments = self._attach_hand_evidence(segments, detected, hand_mask)
        segments = self._finalize_exclusions(rgb, segments)
        candidates: list[Candidate] = []
        destination = self.cache_dir / record.image_id
        destination.mkdir(parents=True, exist_ok=True)
        for segment in segments:
            for exclusion_kind, exclusion_mask in dict(segment.get("image_exclusions", {})).items():
                if not np.any(exclusion_mask):
                    continue
                exclusion_id = uuid.uuid4().hex
                exclusion_path = destination / f".mozarie-pending-{exclusion_id}.tmp"
                Image.fromarray(np.asarray(exclusion_mask, dtype=np.uint8)).save(exclusion_path, format="PNG")
                candidates.append(Candidate(
                    candidate_id=exclusion_id,
                    class_name=SOURCE_LABELS[f"{exclusion_kind}_exclusion"],
                    confidence=None,
                    mask_path=exclusion_path,
                    color="#4ac3df",
                    source=f"{exclusion_kind}_exclusion",
                    origin="auto",
                    role=CandidateRole.EXCLUDE,
                    forced=self.settings["detection"].get("exclude_forced_default", True),
                ))
            if segment["class_name"] not in TARGET_CLASSES:
                continue
            apply_mask = np.asarray(segment["mask"]).copy()
            # Keep the detector/SAM mask intact.  Hands and fluid are separate
            # exclusion candidates, so their checkbox can genuinely restore the
            # underlying target mask when turned off.
            candidate_id = uuid.uuid4().hex
            mask_path = destination / f".mozarie-pending-{candidate_id}.tmp"
            Image.fromarray(np.asarray(apply_mask, dtype=np.uint8)).save(mask_path, format="PNG")
            candidates.append(
                Candidate(
                    candidate_id=candidate_id,
                    class_name=segment["class_name"],
                    confidence=segment["confidence"],
                    mask_path=mask_path,
                    color=DEFAULT_COLORS.get(segment["class_name"], "#5bb6d5"),
                    source=segment["source"],
                    refinement=segment.get("refinement"),
                )
            )
            for exclusion_kind, exclusion_mask in dict(segment.get("exclusions", {})).items():
                if not np.any(exclusion_mask):
                    continue
                exclusion_source = f"{exclusion_kind}_exclusion"
                exclusion_id = uuid.uuid4().hex
                exclusion_path = destination / f".mozarie-pending-{exclusion_id}.tmp"
                Image.fromarray(np.asarray(exclusion_mask, dtype=np.uint8)).save(exclusion_path, format="PNG")
                candidates.append(Candidate(
                    candidate_id=exclusion_id,
                    class_name=SOURCE_LABELS[exclusion_source],
                    confidence=None,
                    mask_path=exclusion_path,
                    color="#4ac3df",
                    source=exclusion_source,
                    origin="auto",
                    role=CandidateRole.EXCLUDE,
                    enabled=True,
                    forced=self.settings["detection"].get("exclude_forced_default", True),
                ))
        return candidates

    def add_boundary_candidate(self, image_id: str, payload: dict[str, Any], *, _gate_held: bool = False) -> dict[str, Any]:
        if not _gate_held:
            # Keep this gate for the complete boundary pipeline, including SAM
            # refinement and candidate publication, while allowing its small
            # internal critical sections to re-enter it.
            with self.inference_lock:
                return self.add_boundary_candidate(image_id, payload, _gate_held=True)
        with self.image_io_lock(image_id):
            record = self.image_for_id(image_id)
            self._assert_record_stat_matches(record)
        polygon_mask: np.ndarray | None = None
        if "points" in payload:
            roi, point, polygon_mask = read_polygon_boundary_request(payload, record.width, record.height)
        else:
            roi, point = read_boundary_request(payload, record.width, record.height)
        with self.image_io_lock(image_id):
            self._assert_record_stat_matches(record)
            with Image.open(record.path) as image:
                rgb = np.asarray(ImageOps.exif_transpose(image).convert("RGB")).copy()
        with self.inference_lock:
            with self.lock:
                if self.job.state in {"running", "pausing"} or self._has_active_worker():
                    raise ClientError("既存の処理が完了してから境界を検出してください。")
            with self.sam_lock:
                predictor = self._sam_predictor_for(record, rgb)
                masks, scores, _logits = predictor.predict(
                    point_coords=np.asarray([point], dtype=np.float32),
                    point_labels=np.asarray([1], dtype=np.int32),
                    box=np.asarray(roi, dtype=np.float32),
                    multimask_output=True,
                )
        mask, confidence = select_best_sam_mask(masks, scores)
        clipped = clip_mask_to_roi(mask, roi)
        if polygon_mask is not None:
            clipped = np.where(polygon_mask > 0, clipped, 0).astype(np.uint8)
        if not np.any(clipped):
            raise ClientError("境界を検出できませんでした。別の位置をクリックしてください。")

        with self.lock:
            if self.images.get(image_id) is not record:
                raise ClientError("フォルダの再読み込み後に境界の検出結果を受け取ったため、破棄しました。", "catalog_changed")

        # Keep the selected SAM shape as APPLY. Hand/fluid removal is represented
        # by an independently toggleable EXCLUDE candidate just as in auto detect.
        boundary_segment = {
            "class_name": "penis",
            "confidence": confidence,
            "mask": clipped.copy(),
            "source": "boundary",
        }
        with self.inference_lock:
            with self.lock:
                if self.job.state in {"running", "pausing"} or self._has_active_worker():
                    raise ClientError("既存の処理が完了してから境界を検出してください。")
            hand_mask = np.zeros(rgb.shape[:2], dtype=np.uint8)
            hand_boxes = [box for box in (padded_hand_box(box, rgb.shape[:2]) for box in self._boundary_hand_boxes(rgb)) if box is not None]
            if hand_boxes:
                if self.settings["models"].get("hand_segmentation_enabled"):
                    with self.hand_segmentation_lock:
                        specialist = self._hand_segmentation_predictor_for(record, rgb)
                        for box in hand_boxes:
                            masks, _scores, _ = specialist.predict(
                                point_coords=None, point_labels=None, box=np.asarray(box, dtype=np.float32), multimask_output=False,
                            )
                            confirmed = accepted_specialist_hand_mask(masks, rgb.shape[:2], box)
                            if confirmed is not None:
                                hand_mask = np.maximum(hand_mask, confirmed)
                else:
                    with self.sam_lock:
                        hand_mask = self._apply_sam_hand_fallback(
                            self._sam_predictor_for(record, rgb), hand_boxes, rgb.shape[:2], hand_mask
                        )
            if np.any(hand_mask):
                boundary_segment["image_exclusions"] = {"hand": hand_mask}
            boundary_segment = self._finalize_exclusions(rgb, [boundary_segment])[0]
            candidate_id = uuid.uuid4().hex
            created = [Candidate(
                candidate_id=candidate_id,
                class_name="4点境界" if polygon_mask is not None else "境界",
                confidence=confidence,
                mask_path=self.cache_dir / record.image_id / f"{candidate_id}.png",
                color="#ffffff", source="boundary", origin="boundary",
            )]
            masks = [np.asarray(clipped, dtype=np.uint8)]
            exclusions = {
                **dict(boundary_segment.get("image_exclusions", {})),
                **dict(boundary_segment.get("exclusions", {})),
            }
            for exclusion_kind, exclusion_mask in exclusions.items():
                if not np.any(exclusion_mask):
                    continue
                exclusion_source = f"{exclusion_kind}_exclusion"
                exclusion_id = uuid.uuid4().hex
                created.append(Candidate(
                    candidate_id=exclusion_id, class_name=SOURCE_LABELS[exclusion_source], confidence=None,
                    mask_path=self.cache_dir / record.image_id / f"{exclusion_id}.png", color="#4ac3df",
                    source=exclusion_source, origin="boundary", role=CandidateRole.EXCLUDE,
                    enabled=True,
                    forced=self.settings["detection"].get("exclude_forced_default", True),
                ))
                masks.append(np.asarray(exclusion_mask, dtype=np.uint8))
            temporary_paths: list[Path] = []
            try:
                for item, candidate_mask in zip(created, masks):
                    temporary = item.mask_path.with_name(f".mozarie-pending-{item.candidate_id}.tmp")
                    item.mask_path.parent.mkdir(parents=True, exist_ok=True)
                    Image.fromarray(np.asarray(candidate_mask, dtype=np.uint8)).save(temporary, format="PNG")
                    temporary_paths.append(temporary)
                with self.image_io_lock(image_id):
                    self._assert_record_stat_matches(record)
                    with self.lock:
                        if self.images.get(image_id) is not record:
                            raise ClientError("フォルダを再読み込みしたため、境界の検出結果を破棄しました。")
                    for temporary, candidate in zip(temporary_paths, created):
                        os.replace(temporary, candidate.mask_path)
                    temporary_paths.clear()
                    with self.lock:
                        if self.images.get(image_id) is not record:
                            raise ClientError("フォルダを再読み込みしたため、境界の検出結果を破棄しました。")
                        self.candidates.setdefault(image_id, []).extend(created)
                        revision = self._touch_candidates(image_id)
                        self._persist_candidates(image_id)
            except Exception:
                for path in [*temporary_paths, *(item.mask_path for item in created)]:
                    path.unlink(missing_ok=True)
                raise
        return {
            "candidates": [
                item.as_api_dict(SOURCE_LABELS.get(item.source, item.source), REFINEMENT_LABELS.get(item.refinement or "", ""))
                for item in created
            ],
            "candidateRevision": revision,
        }
