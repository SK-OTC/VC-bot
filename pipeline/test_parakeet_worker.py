"""
Tests for the parts of parakeet_worker.py that need no model: the windowing and the request loop.
Run from the repository root with the same Python that has onnx-asr installed (numpy is enough for these tests):

    python -m unittest pipeline.test_parakeet_worker -v
"""
import io
import json
import unittest

import numpy as np

from pipeline import parakeet_worker as w

SR = w.SR


def tone(seconds, amp=0.3, f=220.0):
    t = np.arange(int(seconds * SR)) / SR
    return (amp * np.sin(2 * np.pi * f * t)).astype(np.float32)


class SplitWindows(unittest.TestCase):
    def test_empty_and_short_audio(self):
        self.assertEqual(w.split_windows(np.zeros(0, dtype=np.float32)), [])
        a = tone(5)
        self.assertEqual(w.split_windows(a), [(0, len(a))])
        b = tone(22.9)  # not yet more than target + search
        self.assertEqual(w.split_windows(b), [(0, len(b))])

    def test_windows_cover_every_sample_once_in_order(self):
        for seconds in (23.5, 40, 61.3, 240, 600):
            a = tone(seconds)
            wins = w.split_windows(a)
            self.assertEqual(wins[0][0], 0)
            self.assertEqual(wins[-1][1], len(a))
            for (s1, e1), (s2, e2) in zip(wins, wins[1:]):
                self.assertEqual(e1, s2, "no gap and no overlap between windows")
            for s, e in wins:
                self.assertLess(s, e)

    def test_windows_are_about_20_seconds_and_never_over_target_plus_search(self):
        wins = w.split_windows(tone(240))
        for s, e in wins[:-1]:
            sec = (e - s) / SR
            self.assertGreaterEqual(sec, w.TARGET_SEC - w.SEARCH_SEC - 0.1)
            self.assertLessEqual(sec, w.TARGET_SEC + 0.1)
        self.assertLessEqual((wins[-1][1] - wins[-1][0]) / SR, w.TARGET_SEC + w.SEARCH_SEC + 0.1)

    def test_the_cut_lands_in_the_quietest_moment_not_in_the_middle_of_a_word(self):
        # loud speech-like tone with a short silence at 18.5 s: the cut must fall inside the silence
        a = tone(45)
        a[int(18.4 * SR) : int(18.7 * SR)] = 0.0
        first_end = w.split_windows(a)[0][1]
        self.assertGreaterEqual(first_end, int(18.4 * SR))
        self.assertLessEqual(first_end, int(18.7 * SR))

    def test_a_tiny_tail_is_merged_into_the_previous_window(self):
        a = tone(43.2)
        wins = w.split_windows(a)
        self.assertGreaterEqual((wins[-1][1] - wins[-1][0]) / SR, w.MIN_WINDOW_SEC)


class FakeResult:
    def __init__(self, tokens, timestamps):
        self.tokens, self.timestamps = tokens, timestamps


class FakeModel:
    """Pretends to recognise: one token per window, at 0.5 s into the window."""

    def __init__(self):
        self.calls = []

    def recognize(self, chunk, sample_rate):
        self.calls.append(len(chunk) / sample_rate)
        return FakeResult([" word"], [0.5])


class Serve(unittest.TestCase):
    def run_serve(self, model, lines, monkey_decode):
        out = []
        original = w.decode
        w.decode = monkey_decode
        try:
            w.serve(model, [l + "\n" for l in lines], out.append)
        finally:
            w.decode = original
        return out

    def test_a_request_returns_tokens_with_times_relative_to_the_file(self):
        model = FakeModel()
        out = self.run_serve(model, [json.dumps({"id": 1, "file": "x.flac"})], lambda p: tone(45))
        self.assertEqual(len(out), 1)
        r = out[0]
        self.assertTrue(r["ok"])
        self.assertEqual(r["id"], 1)
        self.assertEqual(r["windows"], len(model.calls))
        self.assertEqual(len(r["tokens"]), r["windows"])
        times = [t for _, t in r["tokens"]]
        self.assertEqual(times, sorted(times))
        self.assertAlmostEqual(times[0], 0.5, places=2)
        self.assertGreater(times[1], 15, "the second window's tokens are offset by where that window starts")
        self.assertEqual(r["audio_sec"], 45.0)

    def test_errors_report_only_the_kind_and_a_short_message_and_the_loop_keeps_going(self):
        def boom(path):
            raise RuntimeError("ffmpeg could not read the audio file")

        model = FakeModel()
        out = self.run_serve(model, [json.dumps({"id": 2, "file": "bad"}), "not json", "", json.dumps({"id": 3})], boom)
        self.assertFalse(out[0]["ok"])
        self.assertEqual(out[0]["id"], 2)
        self.assertTrue(out[0]["error"].startswith("RuntimeError"))
        self.assertEqual(out[1], {"ok": False, "error": "bad request"})
        self.assertFalse(out[2]["ok"])  # missing "file"
        self.assertEqual(len(out), 3)

    def test_quit_stops_the_loop(self):
        out = self.run_serve(FakeModel(), [json.dumps({"cmd": "quit"}), json.dumps({"id": 9, "file": "x"})], lambda p: tone(1))
        self.assertEqual(out, [])


if __name__ == "__main__":
    unittest.main()
