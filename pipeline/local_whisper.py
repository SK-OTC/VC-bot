#!/usr/bin/env python3
"""Usage: local_whisper.py <audio file> <language> <prompt> [model]  ->  JSON on stdout.
Needs: pip install faster-whisper. The first run downloads the model (about 500 MB for 'small')."""
import json
import sys

from faster_whisper import WhisperModel

path, language, prompt = sys.argv[1], sys.argv[2], sys.argv[3]
model_name = sys.argv[4] if len(sys.argv) > 4 else "small"
model = WhisperModel(model_name, device="cpu", compute_type="int8")
segments, _info = model.transcribe(
    path,
    language=language or None,
    initial_prompt=prompt or None,
    temperature=0.0,
    condition_on_previous_text=False,  # stops one bad sentence from spoiling the rest
    vad_filter=False,  # silence is already cut out before this step
)
out = [
    {
        "start": s.start,
        "end": s.end,
        "text": s.text,
        "avg_logprob": s.avg_logprob,
        "no_speech_prob": s.no_speech_prob,
        "compression_ratio": s.compression_ratio,
    }
    for s in segments
]
json.dump({"segments": out}, sys.stdout)
