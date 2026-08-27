from __future__ import annotations

import ast
import json
import re
import unittest
from pathlib import Path


def translation_calls(source: str) -> list[tuple[str, set[str]]]:
    calls: list[tuple[str, set[str]]] = []
    for match in re.finditer(r'(?<![\w$])t\("([^"]+)"\s*,\s*\{', source):
        key = match.group(1)
        start = match.end() - 1
        depth = 0
        quote: str | None = None
        end = start
        while end < len(source):
            character = source[end]
            if quote:
                if character == "\\":
                    end += 2
                    continue
                if character == quote:
                    quote = None
            elif character in "'\"`":
                quote = character
            elif character == "{":
                depth += 1
            elif character == "}":
                depth -= 1
                if depth == 0:
                    break
            end += 1
        block = source[start + 1:end]
        names = set()
        entries: list[str] = []
        entry_start = 0
        nesting = 0
        quote = None
        for index, character in enumerate(block):
            if quote:
                if character == "\\":
                    continue
                if character == quote:
                    quote = None
            elif character in "'\"`":
                quote = character
            elif character in "([{":
                nesting += 1
            elif character in ")]}":
                nesting -= 1
            elif character == "," and nesting == 0:
                entries.append(block[entry_start:index])
                entry_start = index + 1
        entries.append(block[entry_start:])
        for entry in entries:
            property_name = re.match(r"\s*([A-Za-z_$][\w$]*)(?:\s*:|\s*$)", entry)
            if property_name:
                names.add(property_name.group(1))
        calls.append((key, names))
    return calls


def placeholders(value: str) -> set[str]:
    return set(re.findall(r"\{([^}]+)\}", value))


class TranslationContractTests(unittest.TestCase):
    def test_translation_call_parser_recognizes_shorthand_and_named_properties(self) -> None:
        calls = translation_calls('t("sample", { completed, total: count, current });')
        self.assertEqual(calls, [("sample", {"completed", "total", "current"})])

    def test_parameterized_translations_match_caller_values_exactly_in_both_languages(self) -> None:
        root = Path(__file__).resolve().parents[1]
        index = (root / "static" / "index.html").read_text(encoding="utf-8")
        names = re.findall(r'<script src="/js/([a-z-]+\.js)"></script>', index)
        source = "\\n".join((root / "static" / "js" / name).read_text(encoding="utf-8") for name in names)
        dictionaries = {
            language: json.loads((root / "static" / "i18n" / f"{language}.json").read_text(encoding="utf-8"))
            for language in ("ja", "en")
        }
        for key, parameter_names in translation_calls(source):
            for language, dictionary in dictionaries.items():
                self.assertIn(key, dictionary, f"{language}: {key}")
                self.assertEqual(
                    placeholders(dictionary[key]),
                    parameter_names,
                    f"{language}: {key} caller/translation parameters differ",
                )

    def test_every_shared_translation_key_uses_the_same_placeholders_in_both_languages(self) -> None:
        root = Path(__file__).resolve().parents[1]
        dictionaries = {
            language: json.loads((root / "static" / "i18n" / f"{language}.json").read_text(encoding="utf-8"))
            for language in ("ja", "en")
        }
        for key in sorted(dictionaries["ja"].keys() & dictionaries["en"].keys()):
            self.assertEqual(
                placeholders(dictionaries["ja"][key]),
                placeholders(dictionaries["en"][key]),
                key,
            )

    def test_detect_progress_uses_the_same_complete_contract_in_both_languages(self) -> None:
        root = Path(__file__).resolve().parents[1]
        expected = {"completed", "total", "current"}
        for language in ("ja", "en"):
            dictionary = json.loads((root / "static" / "i18n" / f"{language}.json").read_text(encoding="utf-8"))
            self.assertEqual(placeholders(dictionary["status.detectProgress"]), expected)

    def test_gpu_unavailable_error_is_translated_in_both_languages(self) -> None:
        root = Path(__file__).resolve().parents[1]
        for language in ("ja", "en"):
            dictionary = json.loads((root / "static" / "i18n" / f"{language}.json").read_text(encoding="utf-8"))
            self.assertTrue(dictionary["errorCode.gpu_unavailable"])

    def test_detection_cancellation_explains_that_the_current_image_may_finish(self) -> None:
        root = Path(__file__).resolve().parents[1]
        for language in ("ja", "en"):
            dictionary = json.loads((root / "static" / "i18n" / f"{language}.json").read_text(encoding="utf-8"))
            self.assertRegex(dictionary["status.detectCancelling"], r"現在の画像|current image")

    def test_user_error_dialog_has_a_complete_translation_for_every_presentation_code(self) -> None:
        root = Path(__file__).resolve().parents[1]
        source = (root / "static" / "js" / "core.js").read_text(encoding="utf-8")
        codes = set(re.findall(r':\s*"([a-z_]+)"', source.split("const USER_ERROR_CODES", 1)[1].split("};", 1)[0]))
        codes.add("internal_error")
        for language in ("ja", "en"):
            dictionary = json.loads((root / "static" / "i18n" / f"{language}.json").read_text(encoding="utf-8"))
            for code in codes:
                for part in ("title", "cause", "action"):
                    self.assertTrue(dictionary[f"errorDialog.{code}.{part}"], f"{language}: {code}.{part}")

    def test_every_emitted_error_code_has_a_user_error_presentation(self) -> None:
        root = Path(__file__).resolve().parents[1]
        source = (root / "static" / "js" / "core.js").read_text(encoding="utf-8")
        aliases = set(re.findall(r'([a-z_]+):\s*"[a-z_]+"', source.split("const USER_ERROR_CODES", 1)[1].split("};", 1)[0]))
        emitted: set[str] = set()
        for path in (root / "mozarie").rglob("*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                if isinstance(node.func, ast.Name) and node.func.id in {"ClientError", "ForbiddenClientError"}:
                    self.assertGreaterEqual(len(node.args), 2, f"{path}:{node.lineno} must provide an error code")
                    self.assertIsInstance(node.args[1], ast.Constant, f"{path}:{node.lineno} must use a literal error code")
                    self.assertIsInstance(node.args[1].value, str, f"{path}:{node.lineno} must use a string error code")
                    emitted.add(node.args[1].value)
                for keyword in node.keywords:
                    if keyword.arg == "errorCode" and isinstance(keyword.value, ast.Constant) and keyword.value.value:
                        self.assertIsInstance(keyword.value.value, str, f"{path}:{node.lineno} errorCode must be a string")
                        emitted.add(keyword.value.value)
        self.assertEqual(emitted - aliases, set())

    def test_api_does_not_use_server_error_text_as_user_interface_copy(self) -> None:
        root = Path(__file__).resolve().parents[1]
        source = (root / "static" / "js" / "core.js").read_text(encoding="utf-8")
        self.assertNotIn("data.error ||", source)
