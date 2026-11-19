#!/usr/bin/env python3
"""
Step 1 spike for the Parakeet engine: does onnx-asr run the v2 English model on a CPU, how fast, how much memory,
and does it give timestamps? Prints COUNTS AND TIMINGS ONLY (never transcript text), so it is safe in a public
Actions log. Use --show-sample on your own machine to see a few tokens (needed once, to confirm the token format).

  pip install "onnx-asr[cpu,hub]" psutil
  python scripts/spike/parakeet_spike.py my-audio.wav --repeat 10 --out spike-out

Gate (from the plan): at least 4x real time on a 4-vCPU runner, peak memory under 8 GB, timestamps present.
"""
import argparse
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

# Pinned model files. This is the ONNX export that onnx-asr loads; the original weights are nvidia/parakeet-tdt-0.6b-v2.
REPO = "istupakov/parakeet-tdt-0.6b-v2-onnx"
REVISION = "0bbb45a3365852604aef28b538a8f066f4ccaa85"
INT8_FILES = ["*.int8.onnx", "nemo128.onnx", "vocab.txt", "config.json"]  # the int8 set only: about 0.7 GB, not the 3 GB repo
SR = 16000


def to_wav16k(src, dst):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, "-ac", "1", "-ar", str(SR), "-c:a", "pcm_s16le", dst], check=True)
    with wave.open(dst, "rb") as w:
        frames = w.readframes(w.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


class PeakMemory:
    """Samples this process's resident memory; reports the peak in GB."""

    def __init__(self):
        self.peak = 0
        self._stop = threading.Event()
        self._p = psutil.Process(os.getpid())
        self._t = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        while not self._stop.is_set():
            self.peak = max(self.peak, self._p.memory_info().rss)
            time.sleep(0.2)

    def __enter__(self):
        self._t.start()
        return self

    def __exit__(self, *a):
        self._stop.set()
        self._t.join()
        self.peak = max(self.peak, self._p.memory_info().rss)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--repeat", type=int, default=1, help="repeat the audio N times (to reach about 10 minutes)")
    ap.add_argument("--threads", type=int, default=os.cpu_count() or 4)
    ap.add_argument("--window-sec", type=float, default=20.0, help="onnx-asr handles about 20-30 s per call")
    ap.add_argument("--cache-dir", default=os.path.join(tempfile.gettempdir(), "parakeet-v2-int8"))
    ap.add_argument("--out", default="", help="folder for words.json (contains text: keep it private)")
    ap.add_argument("--show-sample", action="store_true", help="print the first few tokens (local use only)")
    args = ap.parse_args()

    report = {"python": sys.version.split()[0], "threads": args.threads, "window_sec": args.window_sec, "revision": REVISION}

    # 1. download (only the int8 files, pinned revision)
    from huggingface_hub import snapshot_download

    t = time.time()
    path = snapshot_download(repo_id=REPO, revision=REVISION, allow_patterns=INT8_FILES, local_dir=args.cache_dir)
    report["download_sec"] = round(time.time() - t, 1)
    report["model_dir_mb"] = round(sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(path) for f in fs) / 1e6)

    # 2. load once
    import onnx_asr
    import onnxruntime as ort

    so = ort.SessionOptions()
    so.intra_op_num_threads = args.threads
    so.inter_op_num_threads = 1
    with PeakMemory() as mem:
        t = time.time()
        model = onnx_asr.load_model("nemo-parakeet-tdt-0.6b-v2", path, quantization="int8", sess_options=so).with_timestamps()
        report["load_sec"] = round(time.time() - t, 1)

        # 3. audio
        with tempfile.TemporaryDirectory() as tmp:
            audio = to_wav16k(args.audio, os.path.join(tmp, "a.wav"))
        audio = np.tile(audio, args.repeat) if args.repeat > 1 else audio
        audio_sec = len(audio) / SR
        report["audio_sec"] = round(audio_sec, 1)

        # 4. transcribe window by window, one at a time (no parallel batches)
        win = int(args.window_sec * SR)
        tokens_total = 0
        words = []
        first = None
        t0 = time.time()
        for start in range(0, len(audio), win):
            chunk = audio[start : start + win]
            if len(chunk) < SR // 2:
                continue
            r = model.recognize(chunk, sample_rate=SR)
            if first is None:
                first = r
            offset = start / SR
            toks = list(r.tokens or [])
            stamps = list(r.timestamps or [])
            tokens_total += len(toks)
            for tok, ts in zip(toks, stamps):
                words.append((tok, round(offset + float(ts), 3)))
        wall = time.time() - t0

    report["transcribe_sec"] = round(wall, 1)
    report["speed_x_realtime"] = round(audio_sec / wall, 2) if wall else None
    report["peak_memory_gb"] = round(mem.peak / 1e9, 2)
    report["tokens"] = tokens_total
    report["timestamps_present"] = bool(first is not None and first.timestamps is not None and len(first.timestamps) > 0)
    report["timestamp_type"] = type(first.timestamps[0]).__name__ if report["timestamps_present"] else None
    report["gate"] = {
        "speed_ge_4x": (report["speed_x_realtime"] or 0) >= 4,
        "memory_lt_8gb": report["peak_memory_gb"] < 8,
        "timestamps_present": report["timestamps_present"],
    }
    report["gate_passed"] = all(report["gate"].values())

    if args.show_sample and first is not None:
        print("SAMPLE (local only): text=%r" % first.text[:80], file=sys.stderr)
        print("SAMPLE tokens=%r" % (list(first.tokens)[:10],), file=sys.stderr)
        print("SAMPLE timestamps=%r" % (list(first.timestamps)[:10],), file=sys.stderr)
    if args.out:
        os.makedirs(args.out, exist_ok=True)
        with open(os.path.join(args.out, "tokens.json"), "w", encoding="utf-8") as f:
            json.dump(words, f)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
