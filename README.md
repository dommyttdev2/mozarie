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

3. Download the required primary model below.
4. Start Mozarie:

   ```powershell
   .\run.bat
   ```

5. In **Settings > Detection**, use **Browse** to select each downloaded file. Load images, run detection, review ranges, then save.

Mozarie never bundles or downloads model files. Check each provider's terms before use.

## Model downloads

| Feature | File to select | Download / source |
| --- | --- | --- |
| Required genital detection | `nsfw-anime-xl-x1280.onnx` | [Download](https://huggingface.co/01miku/anime-nsfw-segm-yolo26/resolve/1697d5d1827b6a818b350b44bf3ec27f08837a2a/nsfw-anime-xl-x1280.onnx) · [model page](https://huggingface.co/01miku/anime-nsfw-segm-yolo26) |
| Optional outline refinement, boundary tool, hand exclusion | `sam_vit_b_01ec64.pth`, `sam_vit_l_0b3195.pth`, or `sam_vit_h_4b8939.pth` | [Official SAM checkpoints](https://github.com/facebookresearch/segment-anything#model-checkpoints) |
| Optional HandSegNet hand outline | `handsegnet_vit_b_best.safetensors` | [Fixed checkpoint](https://huggingface.co/Ov3rLoRd-MLEngineer/handsegnet-anime-sdxl/resolve/77ff734683306141e56aef9d491958a82508b41a/handsegnet_vit_b_best.safetensors) · [model page](https://huggingface.co/Ov3rLoRd-MLEngineer/handsegnet-anime-sdxl) |

The SAM file must match the selected `vit_b`, `vit_l`, or `vit_h` type. HandSegNet is optional and available only while hand detection is on.

NTD11 and Sensitive are optional supplemental ONNX segmentation models. If their distribution only has a `.pt`, export raw 1024px segmentation ONNX:

```powershell
python -m pip install ultralytics
yolo export model="path\to\model.pt" format=onnx imgsz=1024 end2end=False
```

## Use

1. Import images or a folder.
2. Run automatic detection for the current image or all images.
3. Review ranges and correct them when needed. Hand exclusions cover the detected hand outline; leave **Force exclusions** on in the Exclusion ranges panel to keep those areas out of the mosaic even when adding more mosaic range.
4. Save a copy or overwrite the source. Copy names are suffixed automatically when needed.

Choose a supported GPU in **Settings > Detection** for GPU processing. After the first completed detection, the progress view estimates remaining time excluding pauses. If GPU memory is full, set parallel processing to 1, choose another GPU, or switch to CPU.

## Updates

Use **Check for updates** in Settings, or run `update.bat`. Close Mozarie before applying an update. Settings, model paths, cache, and working images stay local.

## Troubleshooting

- **A model cannot load:** confirm the exact filename above and the selected SAM type.
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
