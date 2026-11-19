// Command line: turn a folder of speaker files into transcript.txt (and optionally a summary).
//   node transcribe.mjs <folder> [--dry-run] [--summary]
// Settings (environment): GROQ_API_KEY, LANGUAGE (default en), GLOSSARY ("VibeCut, CapCut, ..."),
// GROQ_MODEL (default whisper-large-v3), LLM_MODEL (default openai/gpt-oss-120b).
// The folder may contain names.json, e.g. { "speaker-1": "Farah", "speaker-2": "Sam" }.
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPipeline } from './pipeline/run.mjs';
import { GroqEngine } from './pipeline/groq.mjs';
import { displayNames, buildHeader, formatTranscript } from './pipeline/transcript.mjs';
import { ChatClient, summarize } from './pipeline/summary.mjs';

const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

async function main() {
  const dir = process.argv[2];
  const dry = process.argv.includes('--dry-run');
  const wantSummary = process.argv.includes('--summary');
  if (!dir || !existsSync(dir)) throw new Error('usage: node transcribe.mjs <folder with speaker-N-001.ogg files> [--dry-run] [--summary]');

  const groups = new Map();
  for (const f of readdirSync(dir).sort()) {
    const m = /^(speaker-\d+)-\d{3}\.ogg$/.exec(f);
    if (m) groups.set(m[1], [...(groups.get(m[1]) || []), path.join(dir, f)]);
  }
  if (groups.size === 0) throw new Error('no speaker-N-001.ogg files found in that folder');
  const speakers = [...groups.entries()]
    .sort((a, b) => Number(a[0].split('-')[1]) - Number(b[0].split('-')[1]))
    .map(([label, files]) => ({ label, files }));

  const namesFile = path.join(dir, 'names.json');
  const given = existsSync(namesFile) ? JSON.parse(readFileSync(namesFile, 'utf8')) : {};
  const names = displayNames(speakers.map((s) => ({ label: s.label, name: given[s.label] })));

  const language = process.env.LANGUAGE || 'en';
  const engine = dry ? null : new GroqEngine({ apiKey: process.env.GROQ_API_KEY, model: process.env.GROQ_MODEL || 'whisper-large-v3', language });
  const workDir = mkdtempSync(path.join(tmpdir(), 'transcribe-'));
  try {
    const { lines, failures, stats } = await runPipeline({ speakers, engine, workDir, glossary: process.env.GLOSSARY || '', log, opts: { dryRun: dry } });
    const requests = stats.batches;
    log(`${stats.speakers.length} speaker(s), ${stats.speechSec.toFixed(0)} s of speech, ${requests} request(s) needed`);
    if (dry) return log('dry run: nothing was sent');

    const header = buildHeader({
      startedAt: new Date(),
      lengthSec: stats.lengthSec,
      speakers: stats.speakers,
      names,
      engines: stats.engines,
      fallbackBatches: stats.fallbackBatches,
      failedBatches: stats.failedBatches,
    });
    const text = formatTranscript({ lines, failures, names, header });
    writeFileSync(path.join(dir, 'transcript.txt'), text);
    log(`wrote transcript.txt (${stats.transcribedBatches}/${stats.batches} batches transcribed, dropped: ${JSON.stringify(stats.droppedSegments)})`);

    if (wantSummary) {
      const body = text.slice(header.length);
      const result = await summarize({ transcriptBody: body, chat: new ChatClient({ apiKey: process.env.GROQ_API_KEY, model: process.env.LLM_MODEL || 'openai/gpt-oss-120b' }), log });
      if (result.ok) {
        writeFileSync(path.join(dir, 'summary.txt'), result.text + '\n');
        log(`wrote summary.txt (${result.requests} request(s))`);
      } else {
        log(`summary failed: ${result.reason}`);
      }
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`ERROR: ${e.message}`);
  process.exit(2);
});
