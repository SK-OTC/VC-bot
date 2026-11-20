// The Parakeet TDT 0.6B v2 transcription engine. It runs the model in a long-lived Python worker (pipeline/parakeet_worker.py):
// the model is loaded ONCE per job and batches are sent to it one at a time, each given all the vCPUs. It implements the
// same engine interface as GroqEngine: .name and .transcribe(file, { prompt, durationSec }) -> [{ start, end, text }].
//
//  * `prompt` is ignored: Parakeet has no text prompt (the glossary is applied afterwards, see glossary-fix.mjs).
//  * Segments have no no_speech_prob / avg_logprob / compression_ratio, which the cleanup stage treats as a pass.
//  * Errors are EngineErrors with short fixed text. Nothing from the audio or the transcript is ever put in an error or a log.
//  * If the worker dies it is restarted (up to maxRestarts times); a hang is cut off and the worker is replaced.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineError } from './groq.mjs';
import { tokensToSegments } from './parakeet-segments.mjs';

export const PARAKEET_NAME = 'Parakeet TDT 0.6B v2';

// Every worker that is running. If this process ends for any reason (a crash, process.exit, a cancelled job) they are stopped
// too, so a Python process holding about 2 GB of model is never left behind.
const LIVE = new Set();
process.on('exit', () => {
  for (const p of LIVE) {
    try {
      p.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
});
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'parakeet_worker.py');
const defaultPython = (env) => env.PARAKEET_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

export class ParakeetEngine {
  /**
   * command: overridable for tests, e.g. [process.execPath, 'fake-worker.mjs']. threads: ONNX Runtime threads (default all vCPUs).
   * requestTimeoutMs(durationSec) decides how long one batch may take before the worker is considered hung.
   */
  constructor({
    command,
    env = process.env,
    threads = Number(env.PARAKEET_THREADS) || os.cpus().length || 4,
    modelDir = env.PARAKEET_MODEL_DIR || '',
    startupTimeoutMs = 300_000,
    requestTimeoutMs = (durationSec) => 60_000 + Math.max(0, durationSec || 0) * 2000,
    maxRestarts = 2,
    spawnImpl = spawn,
  } = {}) {
    this.name = PARAKEET_NAME;
    this.label = PARAKEET_NAME;
    this.retries = 1; // the pipeline retries a failed batch once before handing it to the fallback
    this.treatEmptyAsFailure = true; // "no text although silence detection found speech" counts as a failure
    this.timeBudgeted = true; // the pipeline watches how fast this engine is and moves on if the time budget would be exceeded
    Object.assign(this, { command: command ?? [defaultPython(env), WORKER], env, threads, modelDir, startupTimeoutMs, requestTimeoutMs, maxRestarts, spawnImpl });
    this.spawnCount = 0;
    this.restarts = 0;
    this.stats = { requests: 0, audioSec: 0, wallSec: 0 };
    this._proc = null;
    this._ready = null; // promise of { ok, reason? } for the current process
    this._pending = new Map();
    this._nextId = 1;
    this._queue = Promise.resolve();
    this._stderrTail = '';
    this._closed = false;
  }

  /** Starts the worker and waits until the model is loaded. Safe to call early (while the meeting is still running). Never throws. */
  start() {
    if (this._closed) return Promise.resolve({ ok: false, reason: 'closed' });
    if (this._ready) return this._ready;
    this._ready = this._spawn();
    return this._ready;
  }

  _spawn() {
    this.spawnCount++;
    this._stderrTail = '';
    return new Promise((resolve) => {
      let settled = false;
      const done = (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      let proc;
      try {
        const [cmd, ...args] = this.command;
        proc = this.spawnImpl(cmd, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...this.env,
            PARAKEET_THREADS: String(this.threads),
            ...(this.modelDir ? { PARAKEET_MODEL_DIR: this.modelDir } : {}),
            HF_HUB_DISABLE_PROGRESS_BARS: '1',
            PYTHONUNBUFFERED: '1',
            PYTHONIOENCODING: 'utf-8',
          },
        });
      } catch (e) {
        return done({ ok: false, reason: `could not start the worker (${e?.code ?? 'error'})` });
      }
      this._proc = proc;
      LIVE.add(proc);
      proc.once('exit', () => LIVE.delete(proc));
      const timer = setTimeout(() => {
        done({ ok: false, reason: 'timed out while loading the model' });
        this._kill(proc);
      }, this.startupTimeoutMs);

      proc.on('error', (e) => done({ ok: false, reason: `could not start the worker (${e?.code ?? 'error'})` }));
      proc.stderr.on('data', (d) => {
        this._stderrTail = (this._stderrTail + d.toString('utf8')).slice(-300); // library warnings only; never shown beyond a short reason
      });
      proc.on('exit', (code) => {
        if (this._proc === proc) this._proc = null;
        done({ ok: false, reason: `the worker exited while starting (code ${code})` });
        for (const [, p] of this._pending) p.reject(new EngineError('transient', 'the Parakeet worker stopped'));
        this._pending.clear();
      });
      createInterface({ input: proc.stdout }).on('line', (line) => {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return; // a stray line from a library is ignored
        }
        if (msg && msg.ready === true) return done({ ok: true });
        if (msg && msg.ready === false) return done({ ok: false, reason: String(msg.error ?? 'the model could not be loaded').slice(0, 150) });
        const p = msg && this._pending.get(msg.id);
        if (p) {
          this._pending.delete(msg.id);
          p.resolve(msg);
        }
      });
    });
  }

  _kill(proc) {
    // Forget the process at once: its 'exit' event arrives later, and until then a new batch must not be sent to it.
    if (this._proc === proc) this._proc = null;
    try {
      proc?.kill('SIGKILL');
    } catch {
      // already gone
    }
  }

  /** Makes sure a worker is loaded, restarting a dead one (a limited number of times). */
  async _ensureRunning() {
    if (this._closed) throw new EngineError('transient', 'Parakeet is closed');
    if (!this._ready) return this._require(await this.start());
    const r = await this._ready;
    if (r.ok && this._proc) return;
    if (!r.ok && this.restarts >= this.maxRestarts) throw new EngineError('transient', `Parakeet is not available: ${r.reason}`);
    if (this.restarts >= this.maxRestarts) throw new EngineError('transient', 'Parakeet stopped too many times');
    this.restarts++;
    this._ready = this._spawn();
    return this._require(await this._ready);
  }

  _require(r) {
    if (!r.ok) throw new EngineError('transient', `Parakeet is not available: ${r.reason}`);
  }

  transcribe(file, { durationSec = 0 } = {}) {
    // One batch at a time: later calls wait for earlier ones, and the timeout clock starts only when a batch is sent.
    const run = this._queue.then(() => this._transcribe(file, durationSec));
    this._queue = run.catch(() => {});
    return run;
  }

  async _transcribe(file, durationSec) {
    await this._ensureRunning();
    const proc = this._proc;
    const id = this._nextId++;
    const t0 = Date.now();
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        this._kill(proc); // a hung worker is replaced on the next call
        reject(new EngineError('transient', 'Parakeet took too long on this batch'));
      }, this.requestTimeoutMs(durationSec));
      this._pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      try {
        proc.stdin.write(`${JSON.stringify({ id, file })}\n`);
      } catch {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(new EngineError('transient', 'the Parakeet worker is not accepting work'));
      }
    });
    if (!response.ok) throw new EngineError('transient', `Parakeet failed: ${String(response.error ?? 'unknown').slice(0, 100)}`);
    this.stats.requests++;
    this.stats.audioSec += Number(response.audio_sec) || durationSec || 0;
    this.stats.wallSec += (Date.now() - t0) / 1000;
    return tokensToSegments(response.tokens);
  }

  /** Stops the worker. Always call it when the job is done. */
  async close() {
    this._closed = true;
    const proc = this._proc;
    this._proc = null;
    if (!proc) return;
    try {
      proc.stdin.write(`${JSON.stringify({ cmd: 'quit' })}\n`);
      proc.stdin.end();
    } catch {
      // the worker is already gone
    }
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        this._kill(proc);
        resolve();
      }, 3000);
      proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}
