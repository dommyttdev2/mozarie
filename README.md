[日本語](README.ja.md)

# Mozarie

Mozarie is a local Windows app for reviewing image sets and applying mosaic edits. It proposes genital-area masks, keeps the final decision with you, and saves PNG, JPEG, and WebP results.

[Latest release](https://github.com/norqis/mozarie/releases/latest) · [Setup](#setup) · [Model downloads](#model-downloads)

## Features

- Load individual images or folders, detect current or all images, and pause, resume, or cancel long jobs.
- Review, hide, clear, and batch-edit candidates; correct masks with the brush, eraser, or boundary tool.
- Save copies or overwrite sources after confirmation. Supported source metadata is carried into the rendered result.

## Setup

1. Install Python 3.11 or newer on Windows.
2. Install dependencies:

   ```powershell
   python -m pip install -r requirements.txt
   ```

3. Prepare a compatible primary-model `.onnx` file.
4. Start Mozarie:

   ```powershell
   .\run.bat
   ```

5. In **Settings > Detection**, use **Browse** to select the primary model. Use **Download** for SAM and hand models, or select files you already have. Load images, run detection, review ranges, then save.

Downloads are opt-in. Mozarie writes supported files to the full project path `models\` and checks the downloaded size and pinned SHA-256 before making a file available. This detects changes to the pinned download, but cannot absolutely guarantee that a file is harmless. It does not re-check model files during startup or detection.

## Model downloads

| Feature | File to select | Download / source |
| --- | --- | --- |
| Required genital detection | A compatible `.onnx` file | Select it with **Browse** in Settings. |
| Optional outline refinement, boundary tool, hand exclusion | `sam_vit_b_01ec64.pth`, `sam_vit_l_0b3195.pth`, or `sam_vit_h_4b8939.pth` | Download the selected type in Mozarie or use the [official SAM checkpoints](https://github.com/facebookresearch/segment-anything#model-checkpoints). Installed under `Mozarie\models\`. |
| Optional anime hand detector | `hand_detect_v1.0_s.onnx` | Download in Mozarie, or use the [pinned source](https://huggingface.co/deepghs/anime_hand_detection/resolve/dba2c5bec15fcee9ac4909b244a84e8783cf46a2/hand_detect_v1.0_s/model.onnx). Installed at `Mozarie\models\ultralytics\anime-hand-v1.0-s.onnx`. |
| Optional HandSegNet hand outline | `handsegnet_vit_b_best.safetensors` | Download in Mozarie, or use the [pinned source](https://huggingface.co/Ov3rLoRd-MLEngineer/handsegnet-anime-sdxl/resolve/77ff734683306141e56aef9d491958a82508b41a/handsegnet_vit_b_best.safetensors). Installed at `Mozarie\models\handsegnet\handsegnet_vit_b_best.safetensors`. |

The primary model needs a 1280 input, a rank-3 prediction output with a 43-channel axis, and a rank-4 prototype output with 32 channels. Its class order is `anus`, `nipple`, `penis`, `vagina`, `female face`, `male face`, `pubic hair`.

The SAM file must match the selected `vit_b`, `vit_l`, or `vit_h` type. HandSegNet is optional and available only while hand detection is on. NTD11 and Sensitive are optional supplemental models.

NTD11 is an optional supplemental ONNX model. Select `ntd11_anime_nsfw_segm_v5-variant1.onnx` from [Anime NSFW Detection / ADetailer All-in-One v5.0-variant1](https://civitai.com/models/1313556?modelVersionId=2350456). Download `sensitive_detect_v07.pt` from the [Sensitive source](https://huggingface.co/sugarknight/sensitive-detect/tree/b7ec7a528841aac3d52411fb4d031d51a8225e40) and convert it to ONNX.

```powershell
python -m pip install ultralytics
yolo export model="C:\...\sensitive_detect_v07.pt" format=onnx imgsz=1024 simplify=False opset=17 end2end=False device=cpu
```

## Use

1. Import images or a folder.
2. Run automatic detection for the current image or all images.
3. Review ranges and correct them when needed. Hand exclusions cover the detected hand outline. Each exclusion has its own **Force exclusion** switch; forced exclusions stay out of the mosaic even when adding more mosaic range.
4. Save a copy or overwrite the source. Copy names are suffixed automatically when needed.

Choose a supported GPU in **Settings > Detection** for GPU processing. After the first completed detection, the progress view estimates remaining time excluding pauses. If GPU memory is full, set parallel processing to 1, choose another GPU, or switch to CPU.

## Updates

Use **Check for updates** in Settings, or run `update.bat`. Close Mozarie before applying an update. Settings, model paths, cache, and working images stay local.

## Troubleshooting

- **A model cannot load:** confirm the selected file and SAM type.
- **GPU memory or CUDA/provider error:** reduce parallel processing, select CPU, or install a compatible ONNX Runtime GPU and PyTorch environment.
- **Need help:** open a [GitHub issue](https://github.com/norqis/mozarie/issues) with the error text and provider.

## Development

```powershell
python -m unittest discover -s tests -v
npm ci
npm test
```

## License

Mozarie is released under the [MIT License](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party and model-source notices.
