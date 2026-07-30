# MosaicStudio

Local browser-based image review and mosaic editor. It is independent from
ComfyUI: it neither starts, stops, nor modifies ComfyUI or `custom_nodes`.

## Start

Run `run.bat`, then open `http://127.0.0.1:8765`.

It uses the existing ComfyUI Portable Python and the existing segmentation
model:

`G:\AI\doujin-ai-lab\tools\ComfyUI_windows_portable\ComfyUI\models\ultralytics\segm\ntd11_anime_nsfw_segm_v5-variant1.pt`

No packages are installed by MosaicStudio.

## Safety of saved files

- The browser sends only a PNG mask. It never re-encodes the source image.
- PNG files are rebuilt by replacing only IDAT image-data chunks. Every
  ancillary chunk, including ComfyUI `prompt` and `workflow` chunks, is copied
  byte-for-byte and verified before an atomic replacement occurs.
- Original file timestamps are retained after saving.
- JPEG and WebP preserve Exif/ICC metadata through Pillow, but the strict
  byte-for-byte manifest guarantee applies to PNG ancillary chunks.

## Tests

```powershell
& 'G:\AI\doujin-ai-lab\tools\ComfyUI_windows_portable\python_embeded\python.exe' -m unittest discover -s tests -v
```
