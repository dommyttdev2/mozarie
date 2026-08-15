[日本語](README.ja.md)

# Mozarie

A local Windows app for reviewing images and applying mosaic edits.

- Automatic mosaic-region detection
- Brush and boundary-based manual editing
- Batch processing for PNG, JPEG, and WebP
- Metadata-preserving image saves
- Runs locally on Windows

## Quick Start

1. Install Python 3.11 or later.
2. Install the dependencies:

   ```powershell
   python -m pip install -r requirements.txt
   ```

3. Download the three models listed below.
4. Start Mozarie:

   ```powershell
   .\run.bat
   ```

5. Open **Settings > Models** and select the three downloaded files.

## Models

| Purpose | File | Download | Source |
| --- | --- | --- | --- |
| Mosaic-region detection | `nsfw-anime-xl-x1280.onnx` | [Download](https://huggingface.co/01miku/anime-nsfw-segm-yolo26/resolve/1697d5d1827b6a818b350b44bf3ec27f08837a2a/nsfw-anime-xl-x1280.onnx) | [Model page](https://huggingface.co/01miku/anime-nsfw-segm-yolo26) |
| Hand detection | `hand_detect_v1.0_s/model.onnx` | [Download](https://huggingface.co/deepghs/anime_hand_detection/resolve/0c4ab4d58aafbd56794c82a9c1fe424f86c5780d/hand_detect_v1.0_s/model.onnx) | [Model page](https://huggingface.co/deepghs/anime_hand_detection/tree/0c4ab4d58aafbd56794c82a9c1fe424f86c5780d/hand_detect_v1.0_s) |
| Boundary selection | `sam_vit_b_01ec64.pth` | [Download](https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth) | [Segment Anything](https://github.com/facebookresearch/segment-anything) |

Model files are not included in this repository. Check the terms and license on each distribution page before use.

## Usage

1. Load image files or a folder.
2. Run automatic detection.
3. Refine the result with the brush or boundary tool.
4. Save the image, then review the saved result.

## Development

```powershell
python -m unittest discover -s tests -v
node tests/test_app_js.cjs
node tests/test_browser_save_contract.cjs
node tests/test_browser_save_runtime.cjs
node tests/test_import_picker_e2e.cjs
```

## License

Mozarie is released under the [MIT License](LICENSE).

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party components.
