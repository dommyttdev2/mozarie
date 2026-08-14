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
        names = {
            item.group(1)
            for item in re.finditer(r'(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:', block)
        }
        calls.append((key, names))
    return calls


class TranslationContractTests(unittest.TestCase):
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

