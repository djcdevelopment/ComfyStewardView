"""The gateway's matcher is a copy, and this is what keeps it one.

src/gateway.js carries a block marked `copied verbatim from
tools/era-archive/web/creators.js`. Every declaration in it is lifted out of both files by
its own declaration line, dedented, and compared. A name that ranks one way in the search
box on the front door and another way on the builders index is the worst kind of bug here:
nothing errors, nothing looks broken, and the visitor is told their builds do not exist.
So drift fails the build instead.

Only the pure part is copied. renderSuggestions and highlightSuggestion are not here:
creators.js draws a different row (no portrait, a different id space, a different list
element) and its own versions reach for closure state this file has no equivalent of. What
the two share is the ranking, and the ranking is what is pinned.
"""
from __future__ import annotations

import re
import sys
import textwrap
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import build  # noqa: E402

CREATORS = build.REPO / "tools" / "era-archive" / "web" / "creators.js"
GATEWAY = Path(build.HERE) / "src" / "gateway.js"

BEGIN = "// ---- copied verbatim from tools/era-archive/web/creators.js: begin"
END = "// ---- copied verbatim from tools/era-archive/web/creators.js: end"

# Anchored on the declaration line, not on a line number: creators.js is edited by other
# lanes and a shifted line is not drift.
DECLARATIONS = [
    "const PLACEHOLDER_NAME =",
    "function searchTerms(",
    "function matchScore(",
    "function compareBuilders(",
    "function filterBuilders(",
    "const plural =",
    "function eraRange(",
    "function builderSummary(",
]


def block(source: str, declaration: str) -> str:
    """The declaration and its body, dedented to top level.

    creators.js keeps four of these inside a page closure and four at module scope, so the
    copy cannot be indentation-for-indentation; it is dedent-for-dedent."""
    lines = source.splitlines()
    anchor = re.compile(r"^(\s*)" + re.escape(declaration))
    for i, line in enumerate(lines):
        found = anchor.match(line)
        if not found:
            continue
        indent = found.group(1)
        if not line.rstrip().endswith("{"):
            return textwrap.dedent(line)
        close = indent + "}"
        for j in range(i + 1, len(lines)):
            if lines[j] == close:
                return textwrap.dedent("\n".join(lines[i:j + 1]))
        raise AssertionError(f"{declaration} has no closing brace at its own indent")
    raise AssertionError(f"{declaration} is not in the source")


class MatcherParity(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.creators = CREATORS.read_text(encoding="utf-8")
        cls.gateway = GATEWAY.read_text(encoding="utf-8")

    def test_the_copied_block_is_marked(self):
        self.assertIn(BEGIN, self.gateway)
        self.assertIn(END, self.gateway)
        self.assertLess(self.gateway.index(BEGIN), self.gateway.index(END))

    def test_every_copied_declaration_lives_inside_the_marked_block(self):
        copied = self.gateway[self.gateway.index(BEGIN):self.gateway.index(END)]
        for declaration in DECLARATIONS:
            self.assertIn(declaration, copied,
                          f"{declaration} is in gateway.js but outside the copied block")

    def test_each_declaration_is_byte_for_byte_the_live_one(self):
        for declaration in DECLARATIONS:
            with self.subTest(declaration=declaration):
                self.assertEqual(block(self.creators, declaration),
                                 block(self.gateway, declaration))

    def test_the_extractor_would_notice_a_change(self):
        """A parity test that cannot fail is decoration. Edit one side in memory and the
        comparison has to go red."""
        drifted = self.gateway.replace("let best = 3;", "let best = 4;")
        self.assertNotEqual(drifted, self.gateway, "matchScore no longer looks like this")
        self.assertNotEqual(block(self.creators, "function matchScore("),
                            block(drifted, "function matchScore("))


if __name__ == "__main__":
    unittest.main()
