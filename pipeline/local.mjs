// Backup transcription on the machine itself (faster-whisper, no account or internet quota).
// Slower than Groq and less accurate with the small model. It is only used if Groq cannot be used.
import { run } from './ffmpeg.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'local_whisper.py');

export class LocalEngine {
  /** command is overridable for tests: an array like ['python3', '/path/to/fake.py'] that takes (file, language, prompt). */
  constructor({ model = 'small', language = 'en', command = ['python3', SCRIPT] } = {}) {
    this.name = `local faster-whisper ${model}`;
    Object.assign(this, { model, language, command });
  }

  async transcribe(file, { prompt = '' } = {}) {
    const [cmd, ...pre] = this.command;
    const r = await run(cmd, [...pre, file, this.language, prompt, this.model]);
    if (r.code !== 0) {
      const err = new Error(`local transcription failed: ${r.stderr.trim().split('\n').slice(-1)[0] || 'unknown error'}`.slice(0, 200));
      err.kind = 'transient';
      throw err;
    }
    let json;
    try {
      json = JSON.parse(r.stdout);
    } catch {
      const err = new Error('local transcription returned something that is not JSON');
      err.kind = 'bad_request';
      throw err;
    }
    return (json.segments || []).map((s) => ({ start: s.start, end: s.end, text: s.text, avg_logprob: s.avg_logprob, no_speech_prob: s.no_speech_prob, compression_ratio: s.compression_ratio }));
  }
}
