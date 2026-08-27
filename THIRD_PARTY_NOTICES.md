# Third-Party Notices

Mozarie is distributed under the [MIT License](LICENSE). The following entries are the direct runtime dependencies declared by this project. This document links to each dependency's official upstream project and license; it does not replace the notices included by installed packages or their transitive dependencies.

| Component | Purpose in Mozarie | Official upstream | License |
| --- | --- | --- | --- |
| Python | Runtime | [python/cpython](https://github.com/python/cpython) | [PSF License](https://docs.python.org/3/license.html) |
| NumPy | Array operations | [numpy/numpy](https://github.com/numpy/numpy) | [BSD-3-Clause](https://github.com/numpy/numpy/blob/main/LICENSE.txt) |
| Pillow | Image decoding and metadata handling | [python-pillow/Pillow](https://github.com/python-pillow/Pillow) | [HPND](https://github.com/python-pillow/Pillow/blob/main/LICENSE) |
| OpenCV | Image processing | [opencv/opencv](https://github.com/opencv/opencv) | [Apache-2.0](https://github.com/opencv/opencv/blob/4.x/LICENSE) |
| ONNX | ONNX export for optional model conversion | [onnx/onnx](https://github.com/onnx/onnx) | [Apache-2.0](https://github.com/onnx/onnx/blob/main/LICENSE) |
| ONNX Runtime | ONNX model execution | [microsoft/onnxruntime](https://github.com/microsoft/onnxruntime) | [MIT](https://github.com/microsoft/onnxruntime/blob/main/LICENSE) |
| PyTorch | SAM runtime | [pytorch/pytorch](https://github.com/pytorch/pytorch) | [BSD-3-Clause](https://github.com/pytorch/pytorch/blob/main/LICENSE) |
| Torchvision | SAM image helpers | [pytorch/vision](https://github.com/pytorch/vision) | [BSD-3-Clause](https://github.com/pytorch/vision/blob/main/LICENSE) |
| Segment Anything | Boundary refinement integration | [facebookresearch/segment-anything at pinned source revision](https://github.com/facebookresearch/segment-anything/tree/dca509fe793f601edb92606367a655c15ac00fdf) | [Apache-2.0](https://github.com/facebookresearch/segment-anything/blob/dca509fe793f601edb92606367a655c15ac00fdf/LICENSE) |
| safetensors | HandSegNet checkpoint loading | [huggingface/safetensors](https://github.com/huggingface/safetensors) | [Apache-2.0](https://github.com/huggingface/safetensors/blob/main/LICENSE) |
| Ultralytics | Optional `.pt` to ONNX conversion CLI | [ultralytics/ultralytics](https://github.com/ultralytics/ultralytics) | [AGPL-3.0](https://github.com/ultralytics/ultralytics/blob/main/LICENSE) or [Enterprise License](https://www.ultralytics.com/license); installed by setup and run manually as a separate CLI command |

## Model Weights

No model weights are included in this repository. Primary, NTD11, and Sensitive models are supplied by the user. When the user explicitly chooses **Download** in Mozarie, SAM and hand-model files are fetched from the fixed sources below and accepted only after their recorded size and SHA-256 match. That check detects changes to the pinned download; it is not an absolute guarantee that a file is harmless. Downloads are not performed at startup or while detecting. The person who supplies a model must verify its provenance, terms, license obligations, and permitted uses.

| Model | Pinned source | License / terms |
| --- | --- | --- |
| Anime hand detector ONNX | [deepghs/anime_hand_detection at `dba2c5b`](https://huggingface.co/deepghs/anime_hand_detection/tree/dba2c5bec15fcee9ac4909b244a84e8783cf46a2) | Provider metadata: `openrail`; review provider terms |
| SAM checkpoints | [Meta Segment Anything checkpoint source](https://github.com/facebookresearch/segment-anything#model-checkpoints) | Apache-2.0 |
| HandSegNet anime SDXL | [pinned revision `77ff734`](https://huggingface.co/Ov3rLoRd-MLEngineer/handsegnet-anime-sdxl/tree/77ff734683306141e56aef9d491958a82508b41a) | Apache-2.0 |
| Sensitive checkpoint | [sugarknight/sensitive-detect](https://huggingface.co/sugarknight/sensitive-detect) | AGPL-3.0; user-supplied; its conversion command is run by the user, not by Mozarie |
| Primary detector ONNX | [01miku/anime-nsfw-segm-yolo26](https://huggingface.co/01miku/anime-nsfw-segm-yolo26) | User-supplied; review the provider's model card and terms |
| NTD11 checkpoint | [NTD11 ZIP](https://civitai.com/api/download/models/2350456?fileId=2240838) | User-supplied adult model; sign in and complete age verification before downloading, then extract its `.pt` and review the provider's terms |

Mozarie installs Segment Anything from GitHub's source archive at the fixed `dca509fe793f601edb92606367a655c15ac00fdf` revision, so installing the Python dependencies does not require Git. Mozarie supports SAM checkpoints supplied by the user. The official Segment Anything repository provides links to its checkpoints and states that SAM is licensed under Apache-2.0. See the [Mozarie model documentation](README.en.md#models) and the [official Segment Anything repository](https://github.com/facebookresearch/segment-anything) for details.

Mozarie optionally supports the [HandSegNet anime SDXL checkpoint](https://huggingface.co/Ov3rLoRd-MLEngineer/handsegnet-anime-sdxl/blob/77ff734683306141e56aef9d491958a82508b41a/LICENSE_WEIGHTS.txt) at pinned revision `77ff734683306141e56aef9d491958a82508b41a`. Its model weights are licensed under [Apache-2.0](https://huggingface.co/Ov3rLoRd-MLEngineer/handsegnet-anime-sdxl/blob/77ff734683306141e56aef9d491958a82508b41a/LICENSE_WEIGHTS.txt).
