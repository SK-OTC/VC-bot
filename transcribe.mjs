// Command line: turn a folder of speaker files into transcript.txt (and optionally a summary).
//   node transcribe.mjs <folder> [--dry-run] [--summary] [--out <file name>]
// Settings (environment): ENGINE_ORDER ("parakeet,groq" by default; use "parakeet" or "groq" alone to compare them),
// GROQ_API_KEY, LANGUAGE (default en), GLOSSARY ("LiteCut=Lite Cut|Lite cut, CapCut, ..."), GROQ_MODEL (default
// whisper-large-v3), LLM_MODEL (default openai/gpt-oss-120b), PARAKEET_PYTHON (Python with onnx-asr installed),
// PARAKEET_MODEL_DIR, PARAKEET_BUDGET_MIN (default 120).
// --out names the transcript file (default transcript.txt), so two engines can be run on the same folder side by side.
// If any glossary correction was made, <out>.glossary-fixes.json is written next to it (stays on this computer).
// The folder may contain names.json, e.g. { "speaker-1": "Farah", "speaker-2": "Sam" }.
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPipeline } from './pipeline/run.mjs';
import { planEngines } from './pipeline/engines.mjs';
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
  const outArg = process.argv.indexOf('--out');
  const outName = path.basename(outArg > 0 && process.argv[outArg + 1] ? process.argv[outArg + 1] : 'transcript.txt'); // a plain file name, never a path
  const budgetMin = Number(process.env.PARAKEET_BUDGET_MIN) || 120;
  const enginePlan = dry ? null : planEngines({ env: process.env, language, groqKey: process.env.GROQ_API_KEY || '', log });
  const { engine = null, fallbackEngine = null } = enginePlan ? await enginePlan.resolve() : {};
  const workDir = mkdtempSync(path.join(tmpdir(), 'transcribe-'));
  try {
    const { lines, failures, stats } = await runPipeline({ speakers, engine, fallbackEngine, workDir, glossary: process.env.GLOSSARY || '', log, budgetSec: budgetMin * 60, opts: { dryRun: dry } });
    const requests = stats.batches;
    log(`${stats.speakers.length} speaker(s), ${stats.speechSec.toFixed(0)} s of speech, ${requests} request(s) needed`);
    if (dry) return log('dry run: nothing was sent');

    const header = buildHeader({
      startedAt: new Date(),
      lengthSec: stats.lengthSec,
      speakers: stats.speakers,
      names,
      engines: stats.engines,
      labels: stats.labels,
      primaryName: stats.primaryName,
      fallbackName: stats.fallbackName,
      fallbackBatches: stats.fallbackBatches,
      failedBatches: stats.failedBatches,
    });
    const text = formatTranscript({ lines, failures, names, header });
    writeFileSync(path.join(dir, outName), text);
    if (stats.glossaryFixes.length) writeFileSync(path.join(dir, `${outName}.glossary-fixes.json`), JSON.stringify(stats.glossaryFixes, null, 2));
    log(`wrote ${outName} (${stats.transcribedBatches}/${stats.batches} batches transcribed, dropped: ${JSON.stringify(stats.droppedSegments)})`);

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
    await enginePlan?.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`ERROR: ${e.message}`);
  process.exit(2);
});
