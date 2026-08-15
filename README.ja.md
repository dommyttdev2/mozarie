[English](README.md)

# Mozarie

画像を確認し、モザイク編集を行うWindows向けローカルアプリです。

- モザイク範囲の自動検出
- ブラシと境界指定による手動編集
- PNG、JPEG、WebPの一括処理
- メタ情報を保持した画像保存
- Windows上でローカル動作

## クイックスタート

1. Python 3.11以降をインストールします。
2. 依存関係をインストールします。

   ```powershell
   python -m pip install -r requirements.txt
   ```

3. 下記の3モデルをダウンロードします。
4. Mozarieを起動します。

   ```powershell
   .\run.bat
   ```

5. **設定 > モデル** を開き、ダウンロードした3ファイルを選択します。

## 使用モデル

| 用途 | ファイル名 | ダウンロード | 配布元 |
| --- | --- | --- | --- |
| モザイク範囲の検出 | `nsfw-anime-xl-x1280.onnx` | [ダウンロード](https://huggingface.co/01miku/anime-nsfw-segm-yolo26/resolve/1697d5d1827b6a818b350b44bf3ec27f08837a2a/nsfw-anime-xl-x1280.onnx) | [配布ページ](https://huggingface.co/01miku/anime-nsfw-segm-yolo26) |
| 手の検出 | `hand_detect_v1.0_s/model.onnx` | [ダウンロード](https://huggingface.co/deepghs/anime_hand_detection/resolve/0c4ab4d58aafbd56794c82a9c1fe424f86c5780d/hand_detect_v1.0_s/model.onnx) | [配布ページ](https://huggingface.co/deepghs/anime_hand_detection/tree/0c4ab4d58aafbd56794c82a9c1fe424f86c5780d/hand_detect_v1.0_s) |
| 境界指定 | `sam_vit_b_01ec64.pth` | [ダウンロード](https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth) | [Segment Anything](https://github.com/facebookresearch/segment-anything) |

主モデルの検出漏れを補うため、次の2モデルを任意で追加できます。

| モデル | 配布元 |
| --- | --- |
| `ntd11_anime_nsfw_segm_v5-variant1` | [Anime NSFW Detection / ADetailer All-in-One](https://civitai.com/models/1313556/anime-nsfw-detection-adetailer-all-in-one) |
| `sensitive_detect_v07` | [sugarknight/sensitive-detect](https://huggingface.co/sugarknight/sensitive-detect/tree/main) |

任意モデルには1024pxのraw ONNX出力を使用します。ダウンロードした`.pt`をUltralyticsで`end2end=False`として変換し、**設定 > モデル** で生成された`.onnx`を指定してください。

```powershell
python -m pip install ultralytics
yolo export model="path\to\model.pt" format=onnx imgsz=1024 end2end=False
```

モデルファイルはこのリポジトリに含まれず、Mozarieが自動でダウンロードすることもありません。使用前に各配布ページの利用規約とライセンスを確認してください。

## 使い方

1. 画像ファイルまたはフォルダを読み込みます。
2. 自動検出を実行します。
3. ブラシまたは境界ツールで結果を調整します。
4. 保存後の画像を確認します。

保存時は元画像のメタ情報を保持します。

## 開発

```powershell
python -m unittest discover -s tests -v
node tests/test_app_js.cjs
node tests/test_browser_save_contract.cjs
node tests/test_browser_save_runtime.cjs
node tests/test_import_picker_e2e.cjs
```

## ライセンス

Mozarieは[MIT License](LICENSE)で公開しています。

サードパーティー製コンポーネントは[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)を参照してください。
