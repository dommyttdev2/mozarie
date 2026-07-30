# Lets Censoring

Local browser-based image review and mosaic editor. It is independent from
ComfyUI: it neither starts, stops, nor modifies ComfyUI or `custom_nodes`.

## Start

Run `run.bat`, then open `http://127.0.0.1:8765`.

It uses the existing ComfyUI Portable Python and the existing segmentation
model:

`G:\AI\doujin-ai-lab\tools\ComfyUI_windows_portable\ComfyUI\models\ultralytics\segm\ntd11_anime_nsfw_segm_v5-variant1.pt`

No packages are installed by Lets Censoring.

## 操作

- ホイール: カーソル位置を中心に拡大・縮小します。
- Shiftキー+ホイール: ブラシ径を変更します。範囲は2から500pxです。
- スペースキーを押しながらドラッグ、または中ボタンドラッグ: 表示を移動します。
- 左ボタンだけがモザイク範囲を描画します。右ボタンは描画しません。
- 自動検出の判定しきい値は0.30から0.90です。初期値0.60で、高くすると誤検出を減らします。
- 「モザイクを適用」は、現在の画像へ候補と手動修正を安全に保存する確定操作です。

## Safety of saved files

- The browser sends only a PNG mask. It never re-encodes the source image.
- PNG files are rebuilt by replacing only IDAT image-data chunks. Every
  ancillary chunk, including ComfyUI `prompt` and `workflow` chunks, is copied
  byte-for-byte and verified before an atomic replacement occurs.
- JPEG files retain every original APP0-APP15 and COM segment byte-for-byte.
  Their manifest and Pillow re-read are verified before replacement.
- WebP files are saved only when they have a supported still-image structure.
  ICCP, EXIF, and XMP chunks must match byte-for-byte after Pillow writes the
  image. Animated or unknown WebP chunk structures are rejected without
  changing the original file.
- Original file timestamps are retained after saving.
- Any metadata mismatch or decode failure aborts before atomic replacement, so
  the original image remains unchanged.

## Tests

```powershell
& 'G:\AI\doujin-ai-lab\tools\ComfyUI_windows_portable\python_embeded\python.exe' -m unittest discover -s tests -v
```
