# Mozarie

Mozarie is a local desktop-oriented image review and mosaic editor. It loads images from a folder or browser import, proposes mosaic and exclusion ranges, lets you refine them by hand, and saves images without discarding their existing PNG, JPEG, or WebP metadata.

## What is included

- Local HTTP server and browser UI.
- Direct ONNX Runtime adapters for target segmentation and hand detection.
- A local PyTorch Segment Anything checkpoint for rectangle and four-point boundary refinement.
- Manual apply/exclude brushes, per-range enable, delete, and blink review aids.
- Japanese and English UI dictionaries.

No model file, image, cache, personal path, or local configuration is included in this repository.

## Requirements

- Windows 10 or later.
- Python 3.11 or later.
- A browser with the File System Access API is recommended for browser copy saves (Chrome or Edge).
- Python packages listed in `requirements.txt`.
- Three local model files selected in **Settings > Models**:
  - Target segmentation model in ONNX format.
  - Hand detection model in ONNX format.
  - A compatible Segment Anything checkpoint.

GPU execution requires an ONNX Runtime GPU build and a compatible CUDA provider. CPU is available in Settings for environments without GPU inference.

## Setup

1. Create and activate a Python environment.
2. Install dependencies: `pip install -r requirements.txt`.
3. Start the application with `python server.py`.
4. Open **Settings > Models** and select the three local files. Mozarie validates their presence before use; it never downloads or bundles models.

Local options are written to `config/local.json`, which is ignored by Git. Defaults are in `config/defaults.json`.

## Model and license responsibilities

Mozarie does not distribute detection or SAM model weights. You are responsible for obtaining each model from its official source and confirming that its license permits your intended use. `THIRD_PARTY_NOTICES.md` identifies the runtime libraries used by Mozarie; it does not grant rights to any model.

## Verification

Run the non-inference test suite from this directory:

```powershell
python -m unittest discover -s tests -v
node tests/test_app_js.cjs
node tests/test_browser_save_contract.cjs
node tests/test_browser_save_runtime.cjs
node tests/test_import_picker_e2e.cjs
```

The tests use fixtures and mocks. They do not run model inference.

## Data handling

- Imported browser files are kept in a temporary session folder until removed or saved.
- Process cache files are written under `.mozarie-cache/` and are ignored by Git.
- Saving preserves image metadata using the existing save pipeline. Always inspect output before publishing.

## License

Source license selection is intentionally left to the repository owner. Do not publish this repository until you have selected a license compatible with every dependency and your distribution plan.
