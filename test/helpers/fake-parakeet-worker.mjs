// A stand-in for pipeline/parakeet_worker.py that speaks the same line protocol, so the engine can be tested without a
// model. What it does is chosen by the FILE NAME of each request (or by environment variables at start-up).
import { createInterface } from 'node:readline';

const mode = process.env.FAKE_START ?? '';
if (mode === 'noise') console.log('some library printed this to stdout');
if (mode === 'fail') {
  console.log(JSON.stringify({ ready: false, error: 'ImportError: onnx_asr is not installed' }));
  process.exit(1);
}
if (mode === 'die') process.exit(3);
if (mode === 'never-ready') setInterval(() => {}, 1000); // loads for ever
else console.log(JSON.stringify({ ready: true, threads: process.env.PARAKEET_THREADS, modelDir: process.env.PARAKEET_MODEL_DIR ?? null }));

const tok = (text, t0) => text.split(' ').map((w, i) => [` ${w}`, +(t0 + i * 0.4).toFixed(2)]);
let busy = 0;
let maxBusy = 0;

createInterface({ input: process.stdin }).on('line', async (line) => {
  const req = JSON.parse(line);
  if (req.cmd === 'quit') process.exit(0);
  const name = String(req.file);
  busy++;
  maxBusy = Math.max(maxBusy, busy);
  try {
    if (name.includes('crash')) process.exit(1);
    if (name.includes('hang')) return;
    if (name.includes('garbage')) console.log('this line is not json');
    if (name.includes('error')) return console.log(JSON.stringify({ id: req.id, ok: false, error: 'RuntimeError: SECRET-TRANSCRIPT-WORDS leaked? no' }));
    if (name.includes('slow')) await new Promise((r) => setTimeout(r, 150));
    const tokens = name.includes('empty') ? [] : [...tok('hello there everyone', 1), ...tok('second sentence here', 9)];
    console.log(JSON.stringify({ id: req.id, ok: true, tokens, windows: 1, audio_sec: 12.5, maxBusy }));
  } finally {
    busy--;
  }
});
