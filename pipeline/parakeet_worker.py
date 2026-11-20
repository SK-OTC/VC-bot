#!/usr/bin/env python3
"""
Parakeet TDT 0.6B v2 on the CPU, as a long-lived worker: the model is loaded ONCE and then serves many batches.
Talks to pipeline/parakeet.mjs with one JSON object per line on stdin / stdout:

  worker -> {"ready": true, "threads": 4}                        (after the model is loaded)
  node   -> {"id": 7, "file": "/tmp/batch.flac"}
  worker -> {"id": 7, "ok": true, "tokens": [[" So", 2.08], ...], "windows": 5, "audio_sec": 103.2}
         -> {"id": 7, "ok": false, "error": "ValueError: ..."}
  node   -> {"cmd": "quit"}

Rules:
  * Nothing but protocol lines goes to stdout (the real stdout is captured at start and sys.stdout is pointed at stderr,
    so a library that prints cannot corrupt the protocol).
  * Nothing from the audio or the transcript is ever written to stderr: counts and exception types only, because the
    job log of a public repository is public.
  * onnx-asr handles about 20-30 s of audio per call, so a batch is cut into windows of about 20 s. Each cut is placed at
    the QUIETEST moment within 3 s before the target, so a word is not sliced in half.
  * The model files are the pinned int8 export described in pipeline/parakeet-model.json.
"""
import json
import os
import subprocess
import sys

import numpy as np

SR = 16000
TARGET_SEC = 20.0  # aim for windows of this length
SEARCH_SEC = 3.0  # look for the quietest moment in the last few seconds of a window
MIN_WINDOW_SEC = 0.5  # a smaller tail is merged into the previous window instead of being sent alone
FRAME_SEC = 0.05  # energy is measured in 50 ms frames


def load_spec():
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "parakeet-model.json"), encoding="utf-8") as f:
        return json.load(f)


def decode(path):
    """Any audio file -> mono 16 kHz float32 samples, using ffmpeg (already required by the pipeline)."""
    p = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-f", "s16le", "-ac", "1", "-ar", str(SR), "-"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if p.returncode != 0:
        raise RuntimeError("ffmpeg could not read the audio file")
    return np.frombuffer(p.stdout, dtype=np.int16).astype(np.float32) / 32768.0


def split_windows(audio, target=TARGET_SEC, search=SEARCH_SEC, sr=SR):
    """
    Cuts audio into [(start_sample, end_sample)] windows of about `target` seconds. Each cut is moved to the quietest
    50 ms frame in the last `search` seconds before the target. Covers every sample exactly once, in order.
    """
    n = len(audio)
    if n == 0:
        return []
    frame = max(1, int(FRAME_SEC * sr))
    windows = []
    start = 0
    while n - start > int((target + search) * sr):
        lo = start + int((target - search) * sr)
        hi = start + int(target * sr)
        best, best_energy = hi, None
        pos = lo
        while pos + frame <= hi:
            seg = audio[pos : pos + frame]
            energy = float(np.mean(seg * seg))
            if best_energy is None or energy < best_energy:
                best, best_energy = pos + frame // 2, energy
            pos += frame
        windows.append((start, best))
        start = best
    windows.append((start, n))
    if len(windows) > 1 and (windows[-1][1] - windows[-1][0]) < int(MIN_WINDOW_SEC * sr):
        last = windows.pop()
        windows[-1] = (windows[-1][0], last[1])
    return windows


def load_model(threads):
    """Downloads (first run only, then cached) and loads the pinned int8 model. onnx-asr is imported here, not at the top."""
    import onnx_asr
    import onnxruntime as ort
    from huggingface_hub import snapshot_download

    spec = load_spec()
    cache = os.environ.get("PARAKEET_MODEL_DIR") or os.path.join(os.path.expanduser("~"), ".cache", "vc-bot", "parakeet-v2-int8")
    path = snapshot_download(repo_id=spec["export_repo"], revision=spec["export_revision"], allow_patterns=spec["files"], local_dir=cache)
    so = ort.SessionOptions()
    so.intra_op_num_threads = threads  # all vCPUs for one batch at a time; batches are never run in parallel
    so.inter_op_num_threads = 1
    return onnx_asr.load_model(spec["onnx_asr_name"], path, quantization="int8", sess_options=so).with_timestamps()


def transcribe_file(model, path):
    """Returns {"tokens": [[text, seconds_from_start_of_file], ...], "windows": n, "audio_sec": s}."""
    audio = decode(path)
    tokens = []
    windows = split_windows(audio)
    for a, b in windows:
        chunk = audio[a:b]
        if len(chunk) < SR // 20:  # under 50 ms: nothing to recognise
            continue
        r = model.recognize(chunk, sample_rate=SR)
        offset = a / SR
        for tok, ts in zip(r.tokens or [], r.timestamps or []):
            tokens.append([tok, round(offset + float(ts), 3)])
    return {"tokens": tokens, "windows": len(windows), "audio_sec": round(len(audio) / SR, 1)}


def serve(model, read, write):
    """The request loop. `read` yields lines, `write` takes a dict. Returns when stdin closes or a quit command arrives."""
    for line in read:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            write({"ok": False, "error": "bad request"})
            continue
        if req.get("cmd") == "quit":
            return
        rid = req.get("id")
        try:
            write({"id": rid, "ok": True, **transcribe_file(model, str(req["file"]))})
        except Exception as e:  # report the kind of problem, never any audio or text
            write({"id": rid, "ok": False, "error": f"{type(e).__name__}: {str(e)[:80]}"})


def main():
    real_out = sys.stdout
    sys.stdout = sys.stderr  # anything a library prints goes to stderr, not into the protocol

    def write(obj):
        real_out.write(json.dumps(obj) + "\n")
        real_out.flush()

    threads = int(os.environ.get("PARAKEET_THREADS") or (os.cpu_count() or 4))
    try:
        model = load_model(threads)
    except Exception as e:
        write({"ready": False, "error": f"{type(e).__name__}: {str(e)[:120]}"})
        return 1
    write({"ready": True, "threads": threads})
    serve(model, sys.stdin, write)
    return 0


if __name__ == "__main__":
    sys.exit(main())
