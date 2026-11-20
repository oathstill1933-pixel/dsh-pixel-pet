"""Tone tags: read once for the voice, stripped from every visible text."""
import unittest

import helpers  # noqa: F401  # puts runtime/ on sys.path, like every other test module
from pixelpet import tone
from pixelpet.dialogue import clean_dialogue


class ToneTakeTests(unittest.TestCase):
    def test_leading_tag_is_split_off(self):
        label, instruct, body = tone.take("[快]好呀，我这就去。")
        self.assertEqual(label, "快")
        self.assertEqual(body, "好呀，我这就去。")
        self.assertIn("轻快", instruct)

    def test_character_table_wins_over_default(self):
        self.assertEqual(tone.take("[静]好的", "claude-girl")[0], "静")
        # A whale-girl-only beat is not registered for the well-mannered character.
        self.assertIsNone(tone.take("[饿]饭", "claude-girl")[0])

    def test_unknown_or_inline_tags_are_left_alone(self):
        self.assertIsNone(tone.take("[1]第一条")[0])
        self.assertIsNone(tone.take("正文提到[快]不算标签")[0])
        self.assertEqual(tone.take("[1]第一条")[2], "[1]第一条")

    def test_unknown_character_falls_back(self):
        self.assertEqual(tone.take("[暖]嗨", "someone-else")[0], "暖")

    def test_extra_table_is_honoured(self):
        self.assertEqual(tone.take("[喵]你好", "someone-else", {"[喵]": "软软地"})[0], "喵")


class DisplayTests(unittest.TestCase):
    def test_bubble_never_shows_a_registered_tag(self):
        self.assertEqual(clean_dialogue("[暖]今天在这里"), "今天在这里")
        self.assertEqual(clean_dialogue("[困]嗯……"), "嗯……")
        self.assertEqual(clean_dialogue("[静]请稍等", ), "请稍等")

    def test_unregistered_and_inline_brackets_survive(self):
        self.assertEqual(clean_dialogue("[未登记]保留"), "[未登记]保留")
        self.assertEqual(clean_dialogue("前[快]后"), "前[快]后")


if __name__ == "__main__":
    unittest.main()
