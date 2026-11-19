// Cutting a batch out of a speaker's full track and writing it as a small FLAC file.
import { writeFile, rm } from 'node:fs/promises';
import { run } from './ffmpeg.mjs';
import { GAP } from './batches.mjs';

const f = (n) => n.toFixed(3);
let scriptStyle = 'new';

export async function extractBatch(wav, batch, out, { gap = GAP } = {}) {
  const args = ['-v', 'error', '-y'];
  const lines = [];
  const labels = [];
  batch.items.forEach((it, i) => {
    args.push('-ss', f(it.origStart), '-t', f(it.len), '-i', wav);
    lines.push(`[${i}:a]apad=whole_dur=${f(it.len + gap)}[a${i}]`);
    labels.push(`[a${i}]`);
  });
  lines.push(`${labels.join('')}concat=n=${batch.items.length}:v=0:a=1[out]`);
  const script = `${out}.filter.txt`;
  await writeFile(script, lines.join(';\n'));
  const tail = ['-map', '[out]', '-ac', '1', '-ar', '16000', '-c:a', 'flac', out];
  // ffmpeg 7+ reads a filter file with "-/filter_complex" and removed "-filter_complex_script" (gone in 8+).
  // ffmpeg 6 and older only know "-filter_complex_script". Try the one that worked last time first.
  const styles = scriptStyle === 'old' ? ['old', 'new'] : ['new', 'old'];
  let r;
  for (const style of styles) {
    const opt = style === 'new' ? ['-/filter_complex', script] : ['-filter_complex_script', script];
    r = await run('ffmpeg', [...args, ...opt, ...tail]);
    if (r.code === 0) {
      scriptStyle = style;
      break;
    }
  }
  await rm(script, { force: true });
  if (r.code !== 0) throw new Error(`ffmpeg could not cut a batch: ${r.stderr.trim().split('\n').slice(-2).join(' ')}`);
}
