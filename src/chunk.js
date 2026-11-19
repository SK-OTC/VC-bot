// Cutting a transcript into pieces for storage and search.
// Why: a D1 statement can carry at most 100 values and 100 KB, a row at most 2 MB, and search works on
// passages anyway. Pieces are cut on line boundaries, so a "[hh:mm:ss] Name:" line is never split unless
// that one line is itself longer than the limit.

export const CHUNK_CHARS = 1500;

export function chunkTranscript(text, max = CHUNK_CHARS) {
  const chunks = [];
  let cur = '';
  const push = () => {
    if (cur) chunks.push(cur);
    cur = '';
  };
  for (const raw of String(text).split('\n')) {
    let line = raw;
    while (line.length > max) {
      // One enormous line (a long monologue): cut at the last space before the limit, or hard at the limit.
      const at = line.lastIndexOf(' ', max);
      const cut = at > max / 2 ? at : max;
      push();
      chunks.push(line.slice(0, cut));
      line = line.slice(cut).trimStart();
    }
    if (cur && cur.length + line.length + 1 > max) push();
    cur += (cur ? '\n' : '') + line;
  }
  push();
  return chunks.filter((c) => c.trim() !== '');
}
