from __future__ import annotations

from .core import *
from .core import _read_detection_parallelism, _read_target_classes
from .image_io import *
from . import image_io as _image_io
from .runtime_types import DetectionModels

globals().update({name: value for name, value in vars(_image_io).items() if not name.startswith("__")})

class DetectionMixin:
    def start_detection(
        self,
        image_ids: list[str],
        confidence: float = DEFAULT_DETECTION_CONFIDENCE,
        parallelism: int = 2,
        target_classes: set[str] | None = None,
    ) -> None:
        # The gate makes starting a detection mutually exclusive with boundary
        # inference and model-cache replacement. It is deliberately not held
        # during the complete background run, so distinct model slots can work.
        with self.inference_lock:
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
        if provider == "gpu":
            assert_onnx_cuda_available()
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
        try:
            {
                "target_segmentation": validate_target_profile,
                "ntd11": validate_generic_yolo_segment_profile,
                "sensitive": validate_generic_yolo_segment_profile,
                "hand_detection": validate_hand_profile,
            }[key](path)
        except ModelProfileError as exc:
            raise ClientError(f"{label}モデルの互換プロファイルが一致しません: {exc}", "model_profile_invalid") from exc
        return path

    def _configured_sam_path(self) -> Path:
        raw_path = str(self.settings.get("models", {}).get("sam_checkpoint", "")).strip()
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
        models = self._load_detection_models()
        with self.lock:
            self.models = models
        return models

    def _ensure_hand_model(self, models: DetectionModels) -> HandDetector:
        if models.hand is not None:
            return models.hand
        model_path = self._configured_model_path("hand_detection", "手の検出")
        provider = str(self.settings["models"].get("provider", "gpu"))
        if provider == "gpu":
            assert_onnx_cuda_available()
        models.hand = HandDetector(model_path, device=provider, gpu_device=int(self.settings["models"].get("gpu_device", 0)))
        return models.hand

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
        try:
            mode = str(self.settings["detection"]["mode"])
            worker_count = min(_read_detection_parallelism(parallelism), len(records))
            model_slots: list[DetectionModels] = []
            for slot_index in range(worker_count):
                self._wait_while_paused(control, job_generation, catalog_generation)
                if control is not None and (control.cancel_requested.is_set() or control.failed.is_set()):
                    self._cancel_job(job_generation, catalog_generation)
                    return
                if not self._job_is_current(job_generation, catalog_generation):
                    return
                model_slots.append(self._ensure_models() if slot_index == 0 else self._load_detection_models())
            slot_lock = threading.Lock()
            next_slot = 0

            # Keep a stable slot per thread by handing each bounded worker its
            # own model bundle, while records themselves are claimed dynamically.
            slot_local = threading.local()
            def claim_and_run(index: int, record: ImageRecord) -> None:
                nonlocal next_slot
                if not hasattr(slot_local, "models"):
                    with slot_lock:
                        slot_local.models = model_slots[next_slot]
                        next_slot += 1
                models = slot_local.models
                self._set_job_current(record.relative_path, job_generation, catalog_generation)
                try:
                    candidates = self._detect_image(models, record, confidence, mode, target_classes or TARGET_CLASSES)
                except RuntimeError as exc:
                    if "out of memory" in str(exc).lower():
                        raise ClientError("GPUメモリが不足しました。並列数を下げてください。") from exc
                    raise
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
                        self._assert_record_fresh(record)
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
                        self._record_job_success(index, record.image_id, None, job_generation, catalog_generation)
                    for path in stale_paths:
                        path.unlink(missing_ok=True)
                self._set_job_current(record.relative_path, job_generation, catalog_generation)

            failures = self._run_fixed_workers(records, worker_count, claim_and_run, control, job_generation, catalog_generation)
            if failures:
                self._fail_job(failures[0][1], job_generation, catalog_generation)
                return
            if control is not None and control.cancel_requested.is_set():
                self._cancel_job(job_generation, catalog_generation)
                return
            self._finish_job(job_generation, catalog_generation)
        except Exception as exc:  # A background job must not kill the HTTP server.
            self._fail_job(exc, job_generation, catalog_generation)

    def _discard_candidates(self, candidates: list[Candidate]) -> None:
        for candidate in candidates:
            candidate.mask_path.unlink(missing_ok=True)

    def _detect_arbitrated_segments(
        self, models: DetectionModels, rgb: Image.Image, confidence: float, target_classes: set[str] | None = None
    ) -> list[dict[str, Any]]:
        width, height = rgb.size
        targets = target_classes or TARGET_CLASSES
        segments = (models.target.detect(np.asarray(rgb), confidence) if targets == TARGET_CLASSES
                    else models.target.detect(np.asarray(rgb), confidence, targets))
        collected = [segment for segment in segments if segment["mask"].shape == (height, width)]
        for source, model in models.auxiliaries:
            tiled_segments: list[dict[str, Any]] = []
            for x_offset, y_offset, tile_width, tile_height in detection_tiles(width, height):
                tile = np.asarray(rgb.crop((x_offset, y_offset, x_offset + tile_width, y_offset + tile_height)))
                if targets == TARGET_CLASSES:
                    detected_segments = model.detect(tile, confidence_for_source(source, confidence), source)
                else:
                    detected_segments = model.detect(tile, confidence_for_source(source, confidence), source, targets)
                for segment in detected_segments:
                    local_mask = np.asarray(segment["mask"], dtype=np.uint8)
                    if local_mask.shape != (tile_height, tile_width):
                        continue
                    merge_segment(
                        tiled_segments,
                        str(segment["class_name"]),
                        float(segment["confidence"]),
                        restore_tile_mask(local_mask, width, height, x_offset, y_offset),
                        source,
                    )
            collected.extend(tiled_segments)
        return arbitrate_segment_sources(collected)

    def _hand_boxes(self, models: DetectionModels, rgb: Image.Image) -> list[tuple[int, int, int, int]]:
        if not self.settings["models"]["hand_detection_enabled"]:
            return []
        hand_model = self._ensure_hand_model(models)
        return hand_model.detect_boxes(np.asarray(rgb), HAND_CONFIDENCE)

    @staticmethod
    def _box_intersects_mask(box: tuple[int, int, int, int], mask: np.ndarray) -> bool:
        left, top, right, bottom = box
        height, width = mask.shape[:2]
        left, right = max(0, left), min(width, right)
        top, bottom = max(0, top), min(height, bottom)
        return left < right and top < bottom and bool(np.any(mask[top:bottom, left:right] > 0))

    def _refine_detected_segments(
        self, models: DetectionModels, record: ImageRecord, rgb: Image.Image, segments: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        detected = [segment for segment in segments if segment["class_name"] in TARGET_CLASSES]
        if not detected:
            return segments
        genital_mask = np.zeros_like(detected[0]["mask"], dtype=np.uint8)
        for segment in detected:
            genital_mask = np.maximum(genital_mask, segment["mask"])
        hand_boxes = self._hand_boxes(models, rgb)
        intersecting_boxes = [box for box in hand_boxes if self._box_intersects_mask(box, genital_mask)]
        hand_mask = np.zeros_like(genital_mask, dtype=np.uint8)
        if intersecting_boxes:
            specialist = bool(self.settings["models"].get("hand_segmentation_enabled"))
            if specialist:
                fallback_boxes: list[tuple[int, int, int, int]] = []
                with self.hand_segmentation_lock:
                    specialist_predictor = self._hand_segmentation_predictor_for(record)
                    for box in intersecting_boxes:
                        padded_box = padded_hand_box(box, genital_mask.shape[:2])
                        if padded_box is None:
                            continue
                        masks, _scores, _ = specialist_predictor.predict(
                            point_coords=None, point_labels=None, box=np.asarray(padded_box, dtype=np.float32), multimask_output=False,
                        )
                        confirmed = accepted_specialist_hand_mask(masks, genital_mask.shape[:2], padded_box, genital_mask)
                        if confirmed is not None:
                            hand_mask = np.maximum(hand_mask, confirmed)
                            continue
                        fallback_boxes.append(padded_box)
                if fallback_boxes:
                    with self.sam_lock:
                        predictor = self._sam_predictor_for(record)
                        for padded_box in fallback_boxes:
                            masks, scores, _ = predictor.predict(
                                point_coords=None, point_labels=None, box=np.asarray(padded_box, dtype=np.float32), multimask_output=True,
                            )
                            confirmed = accepted_hand_sam_mask(masks, scores, genital_mask.shape[:2], padded_box)
                            if confirmed is not None:
                                hand_mask = np.maximum(hand_mask, confirmed)
            else:
                with self.sam_lock:
                    predictor = self._sam_predictor_for(record)
                    for box in intersecting_boxes:
                        padded_box = padded_hand_box(box, genital_mask.shape[:2])
                        if padded_box is None:
                            continue
                        masks, scores, _ = predictor.predict(
                            point_coords=None, point_labels=None, box=np.asarray(padded_box, dtype=np.float32), multimask_output=True,
                        )
                        confirmed = accepted_hand_sam_mask(masks, scores, genital_mask.shape[:2], padded_box)
                        if confirmed is not None:
                            hand_mask = np.maximum(hand_mask, confirmed)

        for segment in detected:
            original_mask = np.asarray(segment["mask"]).copy()
            segment["_detector_mask"] = original_mask
            segment["_confirmed_hand"] = hand_mask
            refined, decision = refine_mask_with_hand(segment["mask"], hand_mask)
            hand_exclusion = ((original_mask > 0) & (np.asarray(refined) == 0)).astype(np.uint8) * 255
            exclusions: dict[str, np.ndarray] = {}
            if decision == "refined":
                segment["mask"] = refined
                segment["refinement"] = "hand"
            if np.any(hand_exclusion):
                exclusions["hand"] = hand_exclusion
            if segment["class_name"] != "penis":
                segment["exclusions"] = exclusions
                continue
            if self.settings["detection"]["fluid_exclusion_enabled"]:
                fluid_mask = white_fluid_mask(rgb, segment["mask"])
                if np.any(fluid_mask):
                    exclusions["fluid"] = fluid_mask
            segment["exclusions"] = exclusions
        return segments

    def _high_precision_segments(
        self, models: DetectionModels, record: ImageRecord, segments: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Refine detector regions with semantic SAM prompts, keeping weak results untouched."""
        if not segments:
            return segments
        with self.sam_lock:
            predictor = self._sam_predictor_for(record)
            for segment in segments:
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
                    segment["refinement"] = "sam_fallback"
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
                    segment["refinement"] = "sam_fallback"
                    continue
                refined, selected_index = selected
                hand_overlap = int(np.count_nonzero((refined > 0) & (hand_mask > 0)))
                if hand_overlap and logits is not None and len(logits) > selected_index:
                    retry_masks, retry_scores, _ = predictor.predict(
                        point_coords=prompt_points, point_labels=labels, box=np.asarray(roi, dtype=np.float32),
                        mask_input=np.asarray(logits[selected_index]), multimask_output=False,
                    )
                    retry = select_semantic_sam_mask(np.asarray([clip_mask_to_roi(mask, roi) for mask in retry_masks]), retry_scores, source_mask, hand_mask, prompt_points, labels)
                    if retry is not None and np.count_nonzero((retry[0] > 0) & (hand_mask > 0)) < hand_overlap:
                        refined = retry[0]
                segment["mask"] = refined
                segment["_apply_mask"] = refined
                segment["refinement"] = "sam_high_precision"
        return segments

    def _detect_image(
        self, models: DetectionModels, record: ImageRecord, confidence: float, mode: str | None = None,
        target_classes: set[str] | None = None,
    ) -> list[Candidate]:
        # Hash and decode are a short per-image phase.  Do not hold the image
        # lock while detector/SAM inference runs.
        with self.image_io_lock(record.image_id):
            self._assert_record_fresh(record)
            with Image.open(record.path) as image:
                rgb = ImageOps.exif_transpose(image).convert("RGB")
        segments = self._detect_arbitrated_segments(models, rgb, confidence, target_classes or TARGET_CLASSES)
        original_masks = {id(segment): np.asarray(segment["mask"]).copy() for segment in segments}
        segments = self._refine_detected_segments(models, record, rgb, segments)
        if mode == "high_precision":
            segments = self._high_precision_segments(models, record, segments)
        candidates: list[Candidate] = []
        destination = self.cache_dir / record.image_id
        destination.mkdir(parents=True, exist_ok=True)
        for segment in segments:
            refined_mask = np.asarray(segment["mask"]).copy()
            apply_mask = np.asarray(segment.get("_apply_mask", original_masks.get(id(segment), refined_mask))).copy()
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
                    enabled=exclusion_kind != "fluid",
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
            self._assert_record_fresh(record)
        polygon_mask: np.ndarray | None = None
        if "points" in payload:
            roi, point, polygon_mask = read_polygon_boundary_request(payload, record.width, record.height)
        else:
            roi, point = read_boundary_request(payload, record.width, record.height)
        with self.inference_lock:
            with self.lock:
                if self.job.state in {"running", "pausing"} or self._has_active_worker():
                    raise ClientError("既存の処理が完了してから境界を検出してください。")
            with self.sam_lock:
                predictor = self._sam_predictor_for(record)
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
        with Image.open(record.path) as image:
            rgb = ImageOps.exif_transpose(image).convert("RGB")
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
            refined_boundary = self._refine_detected_segments(
                self._ensure_models(), record, rgb, [boundary_segment]
            )[0]
            candidate_id = uuid.uuid4().hex
            created = [Candidate(
                candidate_id=candidate_id,
                class_name="4点境界" if polygon_mask is not None else "境界",
                confidence=confidence,
                mask_path=self.cache_dir / record.image_id / f"{candidate_id}.png",
                color="#ffffff", source="boundary", origin="boundary",
            )]
            masks = [np.asarray(clipped, dtype=np.uint8)]
            for exclusion_kind, exclusion_mask in dict(refined_boundary.get("exclusions", {})).items():
                if not np.any(exclusion_mask):
                    continue
                exclusion_source = f"{exclusion_kind}_exclusion"
                exclusion_id = uuid.uuid4().hex
                created.append(Candidate(
                    candidate_id=exclusion_id, class_name=SOURCE_LABELS[exclusion_source], confidence=None,
                    mask_path=self.cache_dir / record.image_id / f"{exclusion_id}.png", color="#4ac3df",
                    source=exclusion_source, origin="boundary", role=CandidateRole.EXCLUDE,
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
                    self._assert_record_fresh(record)
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
