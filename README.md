[日本語](README.ja.md)

# Mozarie

Mozarie is a local Windows app for reviewing multiple images and applying mosaic edits. It can automatically find candidate mosaic regions, lets you confirm or correct each result, and preserves supported image metadata when saving.

## Quick start

1. Install Python 3.11 or later.
2. Install the dependencies:

   ```powershell
   python -m pip install -r requirements.txt
   ```

3. Download the primary detection model and outline model listed below.
4. Start Mozarie:

   ```powershell
   .\run.bat
   ```

5. Open **Settings > Detection**, set both model paths, then load images or a folder.
6. Run automatic detection, review the proposed ranges, make any manual corrections, and save.

## Model setup

### Required

| Purpose | File | Download | Source |
| --- | --- | --- | --- |
| Automatically detect genital areas | `nsfw-anime-xl-x1280.onnx` | [Download](https://huggingface.co/01miku/anime-nsfw-segm-yolo26/resolve/1697d5d1827b6a818b350b44bf3ec27f08837a2a/nsfw-anime-xl-x1280.onnx) | [Model page](https://huggingface.co/01miku/anime-nsfw-segm-yolo26) |
| Refine outlines and use the boundary tool | `sam_vit_b_01ec64.pth` | [Download](https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth) | [Segment Anything](https://github.com/facebookresearch/segment-anything) |

The outline model is also used when high-precision detection, the boundary tool, or hand exclusion needs an object outline.

### Optional: supplement missed detections

NTD11 and Sensitive are optional additional genital-area detectors. Enable either one only when the primary model misses too much in the images you are processing.

| Model | Source |
| --- | --- |
| `ntd11_anime_nsfw_segm_v5-variant1` | [Anime NSFW Detection / ADetailer All-in-One](https://civitai.com/models/1313556/anime-nsfw-detection-adetailer-all-in-one) |
| `sensitive_detect_v07` | [sugarknight/sensitive-detect](https://huggingface.co/sugarknight/sensitive-detect/tree/main) |

Mozarie needs raw 1024px segmentation ONNX exports for these two models. If a distribution does not provide a compatible ONNX file, export the downloaded `.pt` with Ultralytics and `end2end=False`, then select the generated `.onnx` under **Settings > Detection**.

```powershell
python -m pip install ultralytics
yolo export model="path\to\model.pt" format=onnx imgsz=1024 end2end=False
```

### Optional: exclude overlapping hands

Enable this only when hands overlap a detected genital area. It requires a hand-detection ONNX file and uses the outline model above to remove only the overlapping hand portion.

| Model | Source |
| --- | --- |
| Hand detection | [anime_hand_detection](https://huggingface.co/deepghs/anime_hand_detection/tree/0c4ab4d58aafbd56794c82a9c1fe424f86c5780d/hand_detect_v1.0_s) |

### Optional: exclude suspected white fluid

This experimental option needs no additional model. Within a detected penis range, it uses color and area heuristics to exclude small white regions. White highlights, pale details, or other bright objects can be excluded by mistake, so always review the result.

Model files are not included in this repository. Mozarie never downloads or bundles models. Review the terms and license at each distribution source before use.

## Workflow

1. Load individual images or a folder.
2. Run automatic detection for the current image or all images.
3. Review each proposed mosaic range and remove unsuitable candidates.
4. Add or erase ranges with the brush, or use the boundary tool to select an object outline.
5. Save one image or save all selected images.

Saving preserves image metadata supported by PNG, JPEG, and WebP files. Review saved files before publishing.

## Update

Close Mozarie, then double-click `update.bat`. It checks the latest public GitHub Release, shows the version change, and asks before replacing application files. Local settings, models, caches, and working images are preserved. The updater never starts Mozarie automatically.

## Development

Before publishing a release, update `VERSION` to the same semantic version as the GitHub Release tag.

```powershell
python -m unittest discover -s tests -v
node tests/test_app_js.cjs
node tests/test_browser_save_contract.cjs
node tests/test_browser_save_runtime.cjs
node tests/test_import_picker_e2e.cjs
```

## License

Mozarie is released under the [MIT License](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party components and model-source notices.
