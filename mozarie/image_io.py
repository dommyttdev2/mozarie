from .core import *
from .core import _read_save_suffix
import warnings


def _valid_color(value: str) -> bool:
    return len(value) == 7 and value.startswith("#") and all(char in "0123456789abcdefABCDEF" for char in value[1:])


def calculate_block_size(width: int, height: int, divisor: int = 100) -> int:
    return max(4, math.ceil(max(width, height) / divisor))


def inference_device_name() -> str | None:
    if not torch_module().cuda.is_available():
        return None
    return torch_module().cuda.get_device_name(0)


def parse_png_chunks(raw: bytes) -> list[tuple[bytes, bytes]]:
    if not raw.startswith(PNG_SIGNATURE):
        raise ClientError("PNGファイルではありません。")
    chunks: list[tuple[bytes, bytes]] = []
    position = len(PNG_SIGNATURE)
    while position < len(raw):
        if position + 12 > len(raw):
            raise ClientError("PNGチャンクが壊れています。")
        length = int.from_bytes(raw[position:position + 4], "big")
        end = position + 12 + length
        if end > len(raw):
            raise ClientError("PNGチャンクが壊れています。")
        chunk_type = raw[position + 4:position + 8]
        chunks.append((chunk_type, raw[position:end]))
        position = end
    if not chunks or chunks[-1][0] != b"IEND":
        raise ClientError("PNG終端チャンクがありません。")
    return chunks


def png_ancillary_manifest(raw: bytes, *, exclude: set[bytes] | None = None) -> list[str]:
    """Hash the exact bytes of every ancillary chunk, in file order."""
    excluded = exclude or set()
    return [
        f"{chunk_type.decode('ascii', 'replace')}:{hashlib.sha256(chunk).hexdigest()}"
        for chunk_type, chunk in parse_png_chunks(raw)
        if chunk_type[0] & 0x20 and chunk_type not in excluded
    ]


def _png_chunk(chunk_type: bytes, payload: bytes) -> bytes:
    body = chunk_type + payload
    return len(payload).to_bytes(4, "big") + body + (zlib.crc32(body) & 0xFFFFFFFF).to_bytes(4, "big")


def _normalized_exif_bytes(source: bytes) -> bytes:
    with Image.open(io.BytesIO(source)) as source_image:
        exif = source_image.getexif()
    exif[274] = 1
    return exif.tobytes()


def _png_exif_payload(exif: bytes) -> bytes:
    return exif.removeprefix(b"Exif\x00\x00")


def _png_with_original_chunks(source: bytes, image: Image.Image, *, normalize_orientation: bool = False) -> bytes:
    source_chunks = parse_png_chunks(source)
    if any(chunk_type == b"acTL" for chunk_type, _chunk in source_chunks):
        raise ClientError("アニメーションPNGは保存対象外です。")
    source_ihdr = next(chunk for chunk_type, chunk in source_chunks if chunk_type == b"IHDR")

    encoded = io.BytesIO()
    image.save(encoded, format="PNG", optimize=False)
    encoded_chunks = parse_png_chunks(encoded.getvalue())
    encoded_ihdr = next(chunk for chunk_type, chunk in encoded_chunks if chunk_type == b"IHDR")
    source_ihdr_data = source_ihdr[8:-4]
    encoded_ihdr_data = encoded_ihdr[8:-4]
    if normalize_orientation:
        if source_ihdr_data[8:] != encoded_ihdr_data[8:]:
            raise ClientError("PNGの色形式またはビット深度が変化したため保存を中止しました。")
    elif source_ihdr_data != encoded_ihdr_data:
        raise ClientError("このPNGのカラーモードはメタデータを安全に保持して保存できません。")
    encoded_idat = [chunk for chunk_type, chunk in encoded_chunks if chunk_type == b"IDAT"]

    result = bytearray(PNG_SIGNATURE)
    wrote_idat = False
    normalized_exif = _png_exif_payload(_normalized_exif_bytes(source)) if normalize_orientation else None
    for chunk_type, chunk in source_chunks:
        if chunk_type == b"IHDR" and normalize_orientation:
            result.extend(encoded_ihdr)
            continue
        if chunk_type == b"eXIf" and normalized_exif is not None:
            result.extend(_png_chunk(b"eXIf", normalized_exif))
            continue
        if chunk_type == b"IDAT":
            if not wrote_idat:
                result.extend(b"".join(encoded_idat))
                wrote_idat = True
            continue
        result.extend(chunk)
    output = bytes(result)
    excluded = {b"eXIf"} if normalize_orientation else set()
    if png_ancillary_manifest(source, exclude=excluded) != png_ancillary_manifest(output, exclude=excluded):
        raise ClientError("PNGメタデータ検証に失敗したため保存を中止しました。")
    if normalize_orientation:
        with Image.open(io.BytesIO(output)) as verified:
            if verified.getexif().get(274, 1) != 1:
                raise ClientError("PNGの向き情報を正規化できませんでした。")
            verified.load()
    return output


def _parse_jpeg_header(raw: bytes) -> tuple[list[tuple[int, bytes]], bytes]:
    if not raw.startswith(b"\xff\xd8"):
        raise ClientError("JPEGファイルではありません。")
    position = 2
    segments: list[tuple[int, bytes]] = []
    while position < len(raw):
        marker_start = position
        if raw[position] != 0xFF:
            raise ClientError("JPEGヘッダ構造を安全に解析できません。")
        while position < len(raw) and raw[position] == 0xFF:
            position += 1
        if position >= len(raw):
            raise ClientError("JPEGヘッダが壊れています。")
        marker = raw[position]
        position += 1
        if marker == 0xDA:  # Start of Scan: the remaining bytes are compressed image data.
            if position + 2 > len(raw):
                raise ClientError("JPEGスキャンヘッダが壊れています。")
            length = int.from_bytes(raw[position:position + 2], "big")
            if length < 2 or position + length > len(raw):
                raise ClientError("JPEGスキャンヘッダが壊れています。")
            return segments, raw[marker_start:]
        if marker in {0xD8, 0xD9} or 0xD0 <= marker <= 0xD7 or marker == 0x01:
            raise ClientError("対応外のJPEGヘッダ構造です。")
        if position + 2 > len(raw):
            raise ClientError("JPEGヘッダが壊れています。")
        length = int.from_bytes(raw[position:position + 2], "big")
        end = position + length
        if length < 2 or end > len(raw):
            raise ClientError("JPEGヘッダが壊れています。")
        segments.append((marker, raw[marker_start:end]))
        position = end
    raise ClientError("JPEG画像データが見つかりません。")


def _is_jpeg_metadata_marker(marker: int) -> bool:
    return 0xE0 <= marker <= 0xEF or marker == 0xFE


def jpeg_metadata_manifest(raw: bytes) -> list[str]:
    segments, _scan = _parse_jpeg_header(raw)
    return [
        f"FF{marker:02X}:{hashlib.sha256(segment).hexdigest()}"
        for marker, segment in segments
        if _is_jpeg_metadata_marker(marker)
    ]


def _jpeg_metadata_manifest_from_segments(segments: list[tuple[int, bytes]]) -> list[str]:
    return [
        f"FF{marker:02X}:{hashlib.sha256(segment).hexdigest()}"
        for marker, segment in segments
        if _is_jpeg_metadata_marker(marker)
    ]


def _jpeg_exif_orientation_one_segment(source: bytes) -> bytes:
    with Image.open(io.BytesIO(source)) as source_image:
        exif = source_image.getexif()
    exif[274] = 1
    payload = exif.tobytes()
    if not payload.startswith(b"Exif\x00\x00"):
        payload = b"Exif\x00\x00" + payload
    return b"\xff\xe1" + (len(payload) + 2).to_bytes(2, "big") + payload


def _expected_image_format(suffix: str) -> str:
    expected_formats = {
        ".png": "PNG",
        ".jpg": "JPEG",
        ".jpeg": "JPEG",
        ".webp": "WEBP",
    }
    try:
        return expected_formats[suffix.lower()]
    except KeyError as exc:
        raise ClientError("Unsupported image format.") from exc


def _assert_image_suffix_matches_format(suffix: str, image_format: str | None) -> None:
    if image_format != _expected_image_format(suffix):
        raise ClientError("The image content does not match its file extension.")


def _verify_decodable_image(raw: bytes, *, expected_suffix: str | None = None) -> tuple[int, int]:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as image:
                image.load()
                if expected_suffix is not None:
                    _assert_image_suffix_matches_format(expected_suffix, image.format)
                return oriented_image_size(image)
    except (OSError, UnidentifiedImageError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ClientError("保存後の画像を再読込できません。元画像は変更しません。") from exc


def inspect_import_image(path: Path, expected_suffix: str) -> tuple[int, int]:
    """Validate an input image without decoding its complete pixel payload."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as image:
                _assert_image_suffix_matches_format(expected_suffix, image.format)
                size = oriented_image_size(image)
            with Image.open(path) as image:
                image.verify()
        if expected_suffix.lower() in {".jpg", ".jpeg"}:
            with path.open("rb") as source:
                source.seek(-2, os.SEEK_END)
                if source.read() != b"\xff\xd9":
                    raise OSError("truncated JPEG")
        return size
    except (OSError, RuntimeError, UnidentifiedImageError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ClientError("追加画像を読み込めません。") from exc


def _jpeg_with_original_metadata(source: bytes, image: Image.Image, *, normalize_orientation: bool = False) -> bytes:
    source_segments, _source_scan = _parse_jpeg_header(source)
    metadata_segments: list[tuple[int, bytes]] = []
    orientation_replaced = False
    for marker, segment in source_segments:
        if (
            normalize_orientation
            and not orientation_replaced
            and marker == 0xE1
            and segment[4:10] == b"Exif\x00\x00"
        ):
            metadata_segments.append((marker, _jpeg_exif_orientation_one_segment(source)))
            orientation_replaced = True
        elif _is_jpeg_metadata_marker(marker):
            metadata_segments.append((marker, segment))
    source_manifest = _jpeg_metadata_manifest_from_segments(metadata_segments)
    encoded = io.BytesIO()
    image.save(encoded, format="JPEG", quality=95)
    encoded_segments, encoded_scan = _parse_jpeg_header(encoded.getvalue())
    output = b"\xff\xd8" + b"".join(
        segment for _marker, segment in metadata_segments
    ) + b"".join(
        segment for marker, segment in encoded_segments if not _is_jpeg_metadata_marker(marker)
    ) + encoded_scan
    if source_manifest != jpeg_metadata_manifest(output):
        raise ClientError("JPEGメタデータ検証に失敗したため保存を中止しました。")
    _verify_decodable_image(output)
    return output


WEBP_METADATA_CHUNKS = {b"ICCP", b"EXIF", b"XMP "}
WEBP_SUPPORTED_CHUNKS = {b"VP8 ", b"VP8L", b"VP8X", b"ALPH", *WEBP_METADATA_CHUNKS}


def _parse_webp_chunks(raw: bytes) -> list[tuple[bytes, bytes]]:
    if len(raw) < 12 or raw[:4] != b"RIFF" or raw[8:12] != b"WEBP":
        raise ClientError("WebPファイルではありません。")
    if int.from_bytes(raw[4:8], "little") + 8 != len(raw):
        raise ClientError("WebPコンテナサイズを安全に検証できません。")
    chunks: list[tuple[bytes, bytes]] = []
    position = 12
    while position < len(raw):
        if position + 8 > len(raw):
            raise ClientError("WebPチャンクが壊れています。")
        chunk_type = raw[position:position + 4]
        size = int.from_bytes(raw[position + 4:position + 8], "little")
        end = position + 8 + size
        padded_end = end + (size % 2)
        if padded_end > len(raw):
            raise ClientError("WebPチャンクが壊れています。")
        chunks.append((chunk_type, raw[position:padded_end]))
        position = padded_end
    return chunks


def _validate_safe_webp_structure(raw: bytes) -> None:
    chunks = _parse_webp_chunks(raw)
    chunk_types = [chunk_type for chunk_type, _chunk in chunks]
    if any(chunk_type in {b"ANIM", b"ANMF"} for chunk_type in chunk_types):
        raise ClientError("アニメーションWebPは安全保証できないため保存対象外です。")
    if any(chunk_type not in WEBP_SUPPORTED_CHUNKS for chunk_type in chunk_types):
        raise ClientError("対応外のWebPチャンクがあるため保存を中止しました。")
    if sum(chunk_type in {b"VP8 ", b"VP8L"} for chunk_type in chunk_types) != 1:
        raise ClientError("WebP画像データを安全に検証できません。")


def webp_metadata_manifest(raw: bytes, *, exclude: set[bytes] | None = None) -> list[str]:
    _validate_safe_webp_structure(raw)
    excluded = exclude or set()
    return [
        f"{chunk_type.decode('ascii')}:{hashlib.sha256(chunk).hexdigest()}"
        for chunk_type, chunk in _parse_webp_chunks(raw)
        if chunk_type in WEBP_METADATA_CHUNKS and chunk_type not in excluded
    ]


def _webp_with_original_metadata(
    source: bytes, image: Image.Image, source_info: dict[str, Any], *, normalize_orientation: bool = False,
) -> bytes:
    source_manifest = webp_metadata_manifest(source, exclude={b"EXIF"} if normalize_orientation else set())
    save_args = {
        key: source_info[key]
        for key in ("icc_profile", "exif", "xmp")
        if key in source_info
    }
    if normalize_orientation:
        save_args["exif"] = _normalized_exif_bytes(source)
    encoded = io.BytesIO()
    image.save(encoded, format="WEBP", quality=95, **save_args)
    output = encoded.getvalue()
    if source_manifest != webp_metadata_manifest(output, exclude={b"EXIF"} if normalize_orientation else set()):
        raise ClientError("WebPメタデータ検証に失敗したため保存を中止しました。")
    _verify_decodable_image(output)
    if normalize_orientation:
        with Image.open(io.BytesIO(output)) as verified:
            if verified.getexif().get(274, 1) != 1:
                raise ClientError("WebPの向き情報を正規化できませんでした。")
    return output


def _apply_mosaic_to_image(image: Image.Image, mask: np.ndarray, block_size: int) -> Image.Image:
    if block_size < 1:
        raise ClientError("モザイク粗さが正しくありません。")
    original_mode = image.mode
    if original_mode not in {"RGB", "RGBA", "L"}:
        raise ClientError("この画像モードは安全保存に対応していません。")
    image_array = np.asarray(image)
    if mask.shape != image_array.shape[:2]:
        raise ClientError("マスクと画像サイズが一致しません。")
    width, height = image.size

    if original_mode == "RGBA":
        target_size = (max(1, math.ceil(width / block_size)), max(1, math.ceil(height / block_size)))
        alpha = image_array[..., 3].astype(np.float32) / 255.0
        premultiplied = image_array[..., :3].astype(np.float32) * alpha[..., None]
        small_premultiplied = cv2.resize(premultiplied, target_size, interpolation=cv2.INTER_AREA)
        small_alpha = cv2.resize(alpha, target_size, interpolation=cv2.INTER_AREA)
        pixelated_premultiplied = cv2.resize(small_premultiplied, (width, height), interpolation=cv2.INTER_NEAREST)
        pixelated_alpha = cv2.resize(small_alpha, (width, height), interpolation=cv2.INTER_NEAREST)
        pixelated_rgb = np.divide(
            pixelated_premultiplied,
            pixelated_alpha[..., None],
            out=np.zeros_like(pixelated_premultiplied),
            where=pixelated_alpha[..., None] > 0,
        )
        output = image_array.copy()
        output[..., :3] = np.where(mask[..., None] > 0, np.clip(np.rint(pixelated_rgb), 0, 255).astype(np.uint8), image_array[..., :3])
        return Image.fromarray(output)

    pixelated = image.resize(
        (max(1, math.ceil(width / block_size)), max(1, math.ceil(height / block_size))),
        Image.Resampling.BOX,
    ).resize((width, height), Image.Resampling.NEAREST)
    output = np.where(mask[..., None] > 0, np.asarray(pixelated), image_array) if original_mode == "RGB" else np.where(mask > 0, np.asarray(pixelated), image_array)
    return Image.fromarray(output)


def _decode_mask(data_url: str, width: int, height: int) -> np.ndarray:
    if not isinstance(data_url, str) or not data_url.startswith("data:image/png;base64,"):
        raise ClientError("PNG形式の編集マスクが必要です。")
    try:
        raw = base64.b64decode(data_url.split(",", 1)[1], validate=True)
    except (IndexError, binascii.Error) as exc:
        raise ClientError("編集マスクを読み込めません。") from exc
    if len(raw) > MAX_BODY_BYTES:
        raise ClientError("編集マスクが大きすぎます。")
    try:
        with Image.open(io.BytesIO(raw)) as image:
            if image.format != "PNG":
                raise ClientError("The mask must be a PNG image.")
            if image.size != (width, height):
                raise ClientError("編集マスクのサイズが元画像と一致しません。")
            if image.mode in {"RGBA", "LA"}:
                return np.asarray(image.getchannel("A"), dtype=np.uint8)
            if image.mode in {"L", "1"}:
                return np.asarray(image.convert("L"), dtype=np.uint8)
            raise ClientError("The mask must include an alpha channel or be grayscale.")
    except (OSError, UnidentifiedImageError) as exc:
        raise ClientError("編集マスクは有効なPNGではありません。") from exc


def decode_draft_masks(raw_draft: Any, width: int, height: int) -> tuple[np.ndarray | None, np.ndarray | None]:
    if raw_draft is None:
        return None, None
    if not isinstance(raw_draft, dict):
        raise ClientError("手描きマスクの形式が正しくありません。")
    add = raw_draft.get("add")
    exclusion = raw_draft.get("exclusion")
    return (
        _decode_mask(str(add), width, height) if add else None,
        _decode_mask(str(exclusion), width, height) if exclusion else None,
    )


def unique_session_import_destination(path: Path, reserved: set[Path] | None = None) -> Path:
    reserved = reserved if reserved is not None else set()
    if not path.exists() and path not in reserved:
        return path
    for number in range(2, 10000):
        candidate = path.with_name(f"{path.stem}_{number}{path.suffix}")
        if not candidate.exists() and candidate not in reserved:
            return candidate
    raise ClientError("同名ファイルが多すぎるため保存先を決められません。")


def _default_output_destination(record: ImageRecord, suffix: str = "_censored", reserved: set[Path] | None = None) -> Path:
    relative = safe_import_relative_path(record.relative_path)
    target = APP_DIR / "output" / relative
    return unique_session_import_destination(target.with_name(f"{target.stem}{_read_save_suffix(suffix)}{target.suffix}"), reserved)


def render_with_mask(record: ImageRecord, mask: np.ndarray, block_size: int) -> bytes:
    """Render one image without changing the source file or its catalogue state."""
    source = record.path.read_bytes()
    if record.content_digest != "0" * 64 and hashlib.sha256(source).hexdigest() != record.content_digest:
        raise ClientError("元画像が外部で変更されました。画像を再読み込みしてください。", "stale_asset")
    suffix = record.path.suffix.lower()
    with Image.open(io.BytesIO(source)) as source_image:
        source_image.load()
        normalize_orientation = source_image.getexif().get(274, 1) not in {None, 1}
        normalized = ImageOps.exif_transpose(source_image)
        modified = _apply_mosaic_to_image(normalized, mask, block_size)
        if suffix == ".png":
            return _png_with_original_chunks(source, modified, normalize_orientation=normalize_orientation)
        if suffix in {".jpg", ".jpeg"}:
            return _jpeg_with_original_metadata(source, modified, normalize_orientation=normalize_orientation)
        if suffix == ".webp":
            return _webp_with_original_metadata(source, modified, source_image.info, normalize_orientation=normalize_orientation)
    raise ClientError("この画像形式は保存に対応していません。")


def _replace_record_with_rendered_output(record: ImageRecord, rendered_path: Path) -> str:
    """Atomically replace a catalogued source with a previously verified render."""
    if record.content_digest != "0" * 64 and file_sha256(record.path) != record.content_digest:
        raise ClientError("元画像が外部で変更されました。画像を再読み込みしてください。", "stale_asset")
    original_stat = record.path.stat()
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=record.path.parent, suffix=f"{record.path.suffix}.mozarie.tmp", delete=False) as handle:
            temporary_path = Path(handle.name)
            digest = hashlib.sha256()
            with rendered_path.open("rb") as rendered:
                while chunk := rendered.read(IO_CHUNK_BYTES):
                    digest.update(chunk)
                    handle.write(chunk)
            handle.flush()
            os.fsync(handle.fileno())
        _verify_decodable_image(temporary_path.read_bytes())
        os.replace(temporary_path, record.path)
        temporary_path = None
        if record.source_kind == "filesystem":
            try:
                os.utime(record.path, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
            except OSError:
                LOGGER.warning("Saved image timestamp could not be restored: %s", record.path)
        stat = record.path.stat()
        record.mtime_ns = stat.st_mtime_ns
        record.size_bytes = stat.st_size
        record.content_digest = digest.hexdigest()
        return record.content_digest
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def write_rendered_copy(destination: Path, output: bytes) -> None:
    """Write a default-output copy without exposing a partial image."""
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=destination.parent, suffix=f"{destination.suffix}.mozarie.tmp", delete=False) as handle:
            temporary_path = Path(handle.name)
            handle.write(output)
            handle.flush()
            os.fsync(handle.fileno())
        _verify_decodable_image(temporary_path.read_bytes())
        os.replace(temporary_path, destination)
        temporary_path = None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def save_with_mask(record: ImageRecord, mask: np.ndarray, block_size: int) -> str:
    destination = record.path
    original_stat = record.path.stat()
    source = record.path.read_bytes()
    if record.content_digest != "0" * 64 and hashlib.sha256(source).hexdigest() != record.content_digest:
        raise ClientError("元画像が外部で変更されました。画像を再読み込みしてください。", "stale_asset")
    suffix = record.path.suffix.lower()
    with Image.open(io.BytesIO(source)) as source_image:
        source_image.load()
        normalize_orientation = source_image.getexif().get(274, 1) not in {None, 1}
        source_info = dict(source_image.info)
        source_image = ImageOps.exif_transpose(source_image)
        modified = _apply_mosaic_to_image(source_image, mask, block_size)
        if suffix == ".png":
            output = _png_with_original_chunks(source, modified, normalize_orientation=normalize_orientation)
        elif suffix in {".jpg", ".jpeg"}:
            output = _jpeg_with_original_metadata(source, modified, normalize_orientation=normalize_orientation)
        elif suffix == ".webp":
            output = _webp_with_original_metadata(source, modified, source_info, normalize_orientation=normalize_orientation)
        else:
            raise ClientError("この画像形式は安全保存に対応していません。")

    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=destination.parent, suffix=f"{destination.suffix}.mozarie.tmp", delete=False) as handle:
            temporary_path = Path(handle.name)
            handle.write(output)
            handle.flush()
            os.fsync(handle.fileno())
        temporary_bytes = temporary_path.read_bytes()
        if suffix == ".png" and png_ancillary_manifest(source, exclude={b"eXIf"} if normalize_orientation else set()) != png_ancillary_manifest(temporary_bytes, exclude={b"eXIf"} if normalize_orientation else set()):
            raise ClientError("PNGメタデータ検証に失敗したため置換しませんでした。")
        if suffix in {".jpg", ".jpeg"} and not normalize_orientation and jpeg_metadata_manifest(source) != jpeg_metadata_manifest(temporary_bytes):
            raise ClientError("JPEGメタデータ検証に失敗したため置換しませんでした。")
        if suffix == ".webp" and webp_metadata_manifest(source, exclude={b"EXIF"} if normalize_orientation else set()) != webp_metadata_manifest(temporary_bytes, exclude={b"EXIF"} if normalize_orientation else set()):
            raise ClientError("WebPメタデータ検証に失敗したため置換しませんでした。")
        _verify_decodable_image(temporary_bytes)
        os.replace(temporary_path, destination)
        temporary_path = None
        try:
            os.utime(destination, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
        except OSError:
            LOGGER.warning("Saved image timestamp could not be restored: %s", destination)
        return hashlib.sha256(output).hexdigest()
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
