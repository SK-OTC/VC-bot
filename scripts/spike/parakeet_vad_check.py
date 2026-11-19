#!/usr/bin/env python3
"""
Does the 20-30 second audio limit of onnx-asr bite, and does the END of a long batch get cut off?
Runs ONE long batch (default 240 s) three ways, each in a fresh process so time and memory are honest:

  window : our own 20 s windows, one after another (what the spike did)
  piece  : the whole batch in ONE call, no VAD
  vad    : the whole batch through onnx-asr's Silero VAD (it cuts the speech into segments itself)

Then compares them. This measures speed, memory, and COVERAGE (are there words up to the end of the audio?) and how
much the methods agree with each other. It does NOT measure accuracy: that needs a hand-corrected reference (step 4).

  python scripts/spike/parakeet_vad_check.py audio.wav --seconds 240 --cache-dir <model dir>
Prints words, so use public-domain audio only if you paste the output anywhere.
"""
import argparse
import difflib
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import wave

import numpy as np
import psutil

SR = 16000
REPO = "istupakov/parakeet-tdt-0.6b-v2-onnx"
REVISION = "0bbb45a3365852604aef28b538a8f066f4ccaa85"
INT8_FILES = ["*.int8.onnx", "nemo128.onnx", "vocab.txt", "config.json"]


def load_wav(path):
    with wave.open(path, "rb") as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0


def tokens_to_words(pairs):
    """pairs: [(token, time)]. A token that starts with a space begins a new word; others continue the word."""
    words = []
    for tok, t in pairs:
        if not words or tok.startswith(" "):
            words.append({"w": tok.strip(), "t": t})
        else:
            words[-1]["w"] += tok
    return [w for w in words if w["w"]]


class Peak:
    def __init__(self):
        self.peak = 0
        self._stop = threading.Event()
        self._p = psutil.Process(os.getpid())
        self._t = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        while not self._stop.is_set():
            self.peak = max(self.peak, self._p.memory_info().rss)
            time.sleep(0.1)

    def __enter__(self):
        self._t.start()
        return self

    def __exit__(self, *a):
        self._stop.set()
        self._t.join()
        self.peak = max(self.peak, self._p.memory_info().rss)


def run_method(args):
    import onnx_asr
    import onnxruntime as ort
    from huggingface_hub import snapshot_download

    path = snapshot_download(repo_id=REPO, revision=REVISION, allow_patterns=INT8_FILES, local_dir=args.cache_dir)
    so = ort.SessionOptions()
    so.intra_op_num_threads = args.threads
    so.inter_op_num_threads = 1
    audio = load_wav(args.wav)
    audio_sec = len(audio) / SR
    out = {"method": args.method, "audio_sec": round(audio_sec, 1), "threads": args.threads, "error": None}

    with Peak() as mem:
        base = onnx_asr.load_model("nemo-parakeet-tdt-0.6b-v2", path, quantization="int8", sess_options=so)
        model = base.with_timestamps()  # plain adapter with token times (window and piece methods)
        base_rss = mem.peak
        pairs = []
        t0 = time.time()
        try:
            if args.method == "window":
                win = 20 * SR
                for s in range(0, len(audio), win):
                    chunk = audio[s : s + win]
                    if len(chunk) < SR // 2:
                        continue
                    r = model.recognize(chunk, sample_rate=SR)
                    pairs += [(tok, s / SR + float(ts)) for tok, ts in zip(r.tokens or [], r.timestamps or [])]
            elif args.method == "piece":
                r = model.recognize(audio, sample_rate=SR)
                pairs = [(tok, float(ts)) for tok, ts in zip(r.tokens or [], r.timestamps or [])]
            elif args.method == "vad":
                vad = onnx_asr.load_vad("silero")
                # ORDER MATTERS: with_vad() first, then with_timestamps(), gives segments WITH token times. The other order
                # (with_timestamps().with_vad()) silently returns text-only segments with no token times at all.
                segs = list(base.with_vad(vad).with_timestamps().recognize(audio, sample_rate=SR))
                out["segments"] = len(segs)
                out["segment_lengths_s"] = [round(float(s.end) - float(s.start), 1) for s in segs][:60]
                # Are the token times inside a segment absolute, or relative to the segment start? Decide from the data.
                absolute = all(min(s.timestamps) >= float(s.start) - 0.6 for s in segs if s.timestamps)
                out["segment_timestamps_are"] = "absolute" if absolute else "relative to the segment start"
                for s in segs:
                    off = 0.0 if absolute else float(s.start)
                    pairs += [(tok, off + float(ts)) for tok, ts in zip(s.tokens or [], s.timestamps or [])]
        except Exception as e:  # report it, do not hide it
            out["error"] = f"{type(e).__name__}: {str(e)[:200]}"
        wall = time.time() - t0
    words = tokens_to_words(pairs)
    out.update(
        wall_sec=round(wall, 1),
        speed_x_realtime=round(audio_sec / wall, 2) if wall else None,
        peak_memory_gb=round(mem.peak / 1e9, 2),
        memory_before_decoding_gb=round(base_rss / 1e9, 2),
        tokens=len(pairs),
        words=len(words),
        first_word_s=words[0]["t"] if words else None,
        last_word_s=round(words[-1]["t"], 2) if words else None,
        words_in_last_10s=sum(1 for w in words if w["t"] >= audio_sec - 10),
        words_in_last_30s=sum(1 for w in words if w["t"] >= audio_sec - 30),
        word_list=words,
    )
    with open(args.json_out, "w", encoding="utf-8") as f:
        json.dump(out, f)


def tail_rms(audio, secs=(2, 5, 10)):
    res = {}
    for s in secs:
        seg = audio[-int(s * SR) :]
        res[f"last_{s}s"] = round(float(np.sqrt(np.mean(seg**2))), 4)
    return res


def compare(args):
    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, "a.wav")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", args.audio, "-t", str(args.seconds), "-ac", "1", "-ar", str(SR), "-c:a", "pcm_s16le", wav], check=True)
        audio = load_wav(wav)
        print(f"audio: {len(audio) / SR:.1f} s | RMS of the tail (silence is about 0.001, speech 0.02+): {tail_rms(audio)}")
        results = {}
        for method in ("window", "piece", "vad"):
            jo = os.path.join(tmp, f"{method}.json")
            cmd = [sys.executable, __file__, "--worker", "--method", method, "--wav", wav, "--json-out", jo, "--cache-dir", args.cache_dir, "--threads", str(args.threads)]
            print(f"running {method} ...", flush=True)
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=args.timeout)
            if not os.path.exists(jo):
                print(f"  {method} produced no result. stderr tail: {p.stderr[-300:]}")
                continue
            results[method] = json.load(open(jo, encoding="utf-8"))

    print("\n=== speed, memory and coverage ===")
    hdr = f"{'method':8} {'wall s':>7} {'x real':>7} {'peak GB':>8} {'words':>6} {'last word @':>12} {'gap to end':>11} {'words in last 10s':>18}  error"
    print(hdr)
    for m, r in results.items():
        gap = None if r["last_word_s"] is None else round(r["audio_sec"] - r["last_word_s"], 1)
        print(f"{m:8} {r['wall_sec']:>7} {r['speed_x_realtime']:>7} {r['peak_memory_gb']:>8} {r['words']:>6} {str(r['last_word_s']):>12} {str(gap):>11} {r['words_in_last_10s']:>18}  {r['error'] or ''}")
    if "vad" in results:
        v = results["vad"]
        print(f"\nVAD made {v.get('segments')} segments; token times are {v.get('segment_timestamps_are')}; segment lengths (s): {v.get('segment_lengths_s')}")

    print("\n=== how well the methods agree with each other (word sequence similarity, NOT accuracy) ===")
    names = list(results)
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            a = [w["w"].lower().strip(".,;:!?\"'") for w in results[names[i]]["word_list"]]
            b = [w["w"].lower().strip(".,;:!?\"'") for w in results[names[j]]["word_list"]]
            print(f"  {names[i]} vs {names[j]}: {difflib.SequenceMatcher(None, a, b, autojunk=False).ratio():.3f}  ({len(a)} vs {len(b)} words)")

    print("\n=== the last 14 words each method produced ===")
    for m, r in results.items():
        print(f"  {m:7}: {' '.join(w['w'] for w in r['word_list'][-14:])}")
    print("\n=== a 14-word sample from the middle of the audio, each method ===")
    for m, r in results.items():
        mid = len(r["word_list"]) // 2
        print(f"  {m:7}: {' '.join(w['w'] for w in r['word_list'][mid:mid+14])}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("audio", nargs="?")
    ap.add_argument("--seconds", type=float, default=240.0)
    ap.add_argument("--cache-dir", required=True)
    ap.add_argument("--threads", type=int, default=os.cpu_count() or 4)
    ap.add_argument("--timeout", type=int, default=1800)
    ap.add_argument("--worker", action="store_true")
    ap.add_argument("--method")
    ap.add_argument("--wav")
    ap.add_argument("--json-out")
    a = ap.parse_args()
    run_method(a) if a.worker else compare(a)
