# Third-Party Notices

Mozarie is distributed under the [MIT License](LICENSE). The following direct runtime dependencies are distributed under their own licenses. This document links to each dependency's official upstream project and license; it does not replace the notices included by installed packages.

| Component | Purpose in Mozarie | Official upstream | License |
| --- | --- | --- | --- |
| Python | Runtime | [python/cpython](https://github.com/python/cpython) | [PSF License](https://docs.python.org/3/license.html) |
| NumPy | Array operations | [numpy/numpy](https://github.com/numpy/numpy) | [BSD-3-Clause](https://github.com/numpy/numpy/blob/main/LICENSE.txt) |
| Pillow | Image decoding and metadata handling | [python-pillow/Pillow](https://github.com/python-pillow/Pillow) | [HPND](https://github.com/python-pillow/Pillow/blob/main/LICENSE) |
| OpenCV | Image processing | [opencv/opencv](https://github.com/opencv/opencv) | [Apache-2.0](https://github.com/opencv/opencv/blob/4.x/LICENSE) |
| ONNX Runtime | ONNX model execution | [microsoft/onnxruntime](https://github.com/microsoft/onnxruntime) | [MIT](https://github.com/microsoft/onnxruntime/blob/main/LICENSE) |
| PyTorch | SAM runtime | [pytorch/pytorch](https://github.com/pytorch/pytorch) | [BSD-3-Clause](https://github.com/pytorch/pytorch/blob/main/LICENSE) |
| Torchvision | SAM image helpers | [pytorch/vision](https://github.com/pytorch/vision) | [BSD-3-Clause](https://github.com/pytorch/vision/blob/main/LICENSE) |
| Segment Anything | Boundary refinement integration | [facebookresearch/segment-anything at pinned source revision](https://github.com/facebookresearch/segment-anything/tree/dca509fe793f601edb92606367a655c15ac00fdf) | [Apache-2.0](https://github.com/facebookresearch/segment-anything/blob/dca509fe793f601edb92606367a655c15ac00fdf/LICENSE) |
| safetensors | HandSegNet checkpoint loading | [huggingface/safetensors](https://github.com/huggingface/safetensors) | [Apache-2.0](https://github.com/huggingface/safetensors/blob/main/LICENSE) |

## Model Weights

No model weights are included in this repository, and Mozarie does not download model weights automatically. Target-segmentation and hand-detection ONNX files are selected by the user from local paths. Their provenance, terms, license obligations, and permitted uses must be verified separately by the person who provides them.

Mozarie installs Segment Anything from GitHub's source archive at the fixed `dca509fe793f601edb92606367a655c15ac00fdf` revision, so installing the Python dependencies does not require Git. Mozarie supports SAM checkpoints supplied by the user. The official Segment Anything repository provides links to its checkpoints and states that SAM is licensed under Apache-2.0. See the [Mozarie Model setup documentation](README.md#model-setup) and the [official Segment Anything repository](https://github.com/facebookresearch/segment-anything) for details.

Mozarie optionally supports the user-supplied [HandSegNet anime SDXL checkpoint](https://huggingface.co/Ov3rLoRd-MLEngineer/handsegnet-anime-sdxl/blob/77ff734683306141e56aef9d491958a82508b41a/LICENSE_WEIGHTS.txt) at pinned revision `77ff734683306141e56aef9d491958a82508b41a`. Its model weights are licensed under [Apache-2.0](https://huggingface.co/Ov3rLoRd-MLEngineer/handsegnet-anime-sdxl/blob/77ff734683306141e56aef9d491958a82508b41a/LICENSE_WEIGHTS.txt).
