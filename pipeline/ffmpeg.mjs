// Thin wrappers around ffmpeg / ffprobe. Arguments are always passed as an array (never through a shell).
import { spawn } from 'node:child_process';

export function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', (e) => reject(new Error(`could not start ${cmd}: ${e.message}`)));
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export async function ensureFfmpeg() {
  for (const bin of ['ffmpeg', 'ffprobe']) {
    const r = await run(bin, ['-version']).catch(() => ({ code: 1 }));
    if (r.code !== 0) throw new Error(`${bin} is not installed. Install ffmpeg first (for example: sudo apt-get install -y ffmpeg).`);
  }
}

export async function probeDuration(file) {
  const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const d = Number(r.stdout.trim());
  if (r.code !== 0 || !Number.isFinite(d)) throw new Error(`could not read the length of ${file}`);
  return d;
}

/** Joins one speaker's files end to end and converts to 16 kHz mono 16-bit WAV (easy to cut precisely). */
export async function toWav16kMono(files, out) {
  const args = ['-v', 'error', '-y'];
  for (const f of files) args.push('-i', f);
  if (files.length === 1) {
    args.push('-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out);
  } else {
    const labels = files.map((_, i) => `[${i}:a]`).join('');
    args.push('-filter_complex', `${labels}concat=n=${files.length}:v=0:a=1[c]`, '-map', '[c]', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out);
  }
  const r = await run('ffmpeg', args);
  if (r.code !== 0) throw new Error(`ffmpeg could not convert the audio: ${r.stderr.trim().split('\n').slice(-2).join(' ')}`);
}

export async function detectSilence(wav, { noiseDb = -60, minSilence = 1.5 } = {}) {
  const r = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', wav, '-af', `silencedetect=noise=${noiseDb}dB:d=${minSilence}`, '-f', 'null', '-']);
  if (r.code !== 0) throw new Error('ffmpeg silence detection failed');
  return r.stderr;
}
