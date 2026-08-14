from __future__ import annotations

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


class TranslationContractTests(unittest.TestCase):
    def test_translation_call_parser_recognizes_shorthand_and_named_properties(self) -> None:
        calls = translation_calls('t("sample", { completed, total: count, current });')
        self.assertEqual(calls, [("sample", {"completed", "total", "current"})])

    def test_every_parameterized_translation_preserves_caller_values_in_both_languages(self) -> None:
        root = Path(__file__).resolve().parents[1]
        source = (root / "static" / "app.js").read_text(encoding="utf-8")
        dictionaries = {
            language: json.loads((root / "static" / "i18n" / f"{language}.json").read_text(encoding="utf-8"))
            for language in ("ja", "en")
        }
        for key, parameter_names in translation_calls(source):
            self.assertTrue(parameter_names, key)
            for language, dictionary in dictionaries.items():
                self.assertIn(key, dictionary, f"{language}: {key}")
                placeholders = set(re.findall(r"\{([^}]+)\}", dictionary[key]))
                self.assertTrue(
                    parameter_names <= placeholders,
                    f"{language}: {key} drops caller values {sorted(parameter_names - placeholders)}",
                )

    def test_detect_progress_uses_the_same_complete_contract_in_both_languages(self) -> None:
        root = Path(__file__).resolve().parents[1]
        expected = {"completed", "total", "current"}
        for language in ("ja", "en"):
            dictionary = json.loads((root / "static" / "i18n" / f"{language}.json").read_text(encoding="utf-8"))
            self.assertEqual(set(re.findall(r"\{([^}]+)\}", dictionary["status.detectProgress"])), expected)
