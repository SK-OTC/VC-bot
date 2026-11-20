// finishSession: what the recorder sends, to where, and in what order, for each save/post setting.
// Synthetic audio (needs ffmpeg), a fake engine, a fake summary model and a stubbed upload; nothing touches Discord or the Worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { finishSession } from '../recorder/session.mjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const opt = { skip: hasFfmpeg ? false : 'ffmpeg is not installed' };

const GUILD = '222222222222222222';
const VC = '111111111111111111';
const CHANNEL = '333333333333333333';
const STARTER = '700000000000000001';
const URL_ = `https://worker.example/t/${'B'.repeat(43)}`;
const EXPIRES = 1_800_000_000;

function makeAudio(dir) {
  const out = path.join(dir, 'input-speaker-1.wav');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-t', '3', '-i', 'sine=frequency=440:sample_rate=16000', '-ac', '1', '-ar', '16000', out]);
  assert.equal(r.status, 0, String(r.stderr));
  return out;
}

const engine = { name: 'fake', label: 'Fake engine', async transcribe() { return [{ start: 0.5, end: 2.5, text: 'we agreed the budget today' }]; } };
const chatReturning = (text) => ({ usage: { requests: 0, promptTokens: 0, completionTokens: 0, neurons: 0 }, async complete() { this.usage.requests++; return text; } });
const SHORT = '**Summary**\n- We agreed the budget [00:00:01]\n\n**Decisions**\n- None recorded\n\n**Action items**\n- Unassigned: send it [00:00:01]\n\n**Open questions**\n- None';
const LONG = `**Summary**\n${Array.from({ length: 70 }, (_, i) => `- agreed point ${i} about the budget and the launch plan for the shoes [00:00:01]`).join('\n')}\n\n**Decisions**\n- None recorded\n\n**Action items**\n- Unassigned: send it [00:00:01]\n\n**Open questions**\n- None`;

/** Runs finishSession with scripted fakes. Returns everything that was sent, in order. */
async function run({ team = {}, summary = SHORT, upload = 'ok', dmFails = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'delivery-'));
  const events = [];
  const realFetch = globalThis.fetch;
  let payload = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://worker.example/api/transcripts')) {
      events.push({ type: 'upload' });
      payload = JSON.parse(init.body);
      if (upload === 'fail') return new Response('{}', { status: 500 });
      if (upload === 'nolink') return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, id: payload.id, share_url: URL_, share_expires_at: EXPIRES }), { status: 200 });
    }
    return realFetch(url, init);
  };
  const io = {
    postTranscript: async (a) => { events.push({ type: 'postTranscript', content: a.content, file: a.file.name }); return { messageId: '444444444444444444' }; },
    postText: async (text, o = {}) => { events.push({ type: 'postText', text, replyTo: o.replyTo }); return { messageId: '555555555555555555' }; },
    dm: async (text, o = {}) => { if (dmFails) throw new Error('Cannot send messages to this user'); events.push({ type: 'dm', text, file: o.file?.name }); return { messageId: '666666666666666666' }; },
    postBackup: async () => {},
  };
  const cfg = {
    team: { name: 'Design', glossary: '', language: 'en', backupChannelId: '', transcriptChannelId: CHANNEL, save: true, post: true, dmUserId: '', ...team },
    workerUrl: 'https://worker.example',
    workerSecret: 'secret',
  };
  try {
    const result = await finishSession({
      speakers: [{ label: 'speaker-1', name: 'Farah', files: [makeAudio(dir)] }],
      offsetSec: 0,
      startedAt: Date.UTC(2026, 10, 19, 10, 0, 0),
      cfg,
      engine,
      fallbackEngine: null,
      providers: [{ name: 'groq-gpt-oss', label: 'GPT-OSS 120B on Groq', chat: chatReturning(summary) }],
      io,
      sessionId: 'sess1234',
      voiceChannelId: VC,
      guildId: GUILD,
    });
    return { result, events, payload };
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
}
const types = (events) => events.map((e) => e.type);
const texts = (events, type) => events.filter((e) => e.type === type).map((e) => e.text);

test('default (save + post): transcript file, then save, THEN one message with the summary and the link, as a reply to the transcript', opt, async () => {
  const { result, events, payload } = await run();
  assert.equal(result.ok, true);
  assert.deepEqual(types(events), ['postTranscript', 'upload', 'postText'], 'the link exists only after the save, so the summary message comes after it');
  assert.equal(events[0].file.startsWith('transcript-'), true);
  assert.equal(payload.post_channel_id, CHANNEL);
  assert.equal(payload.transcript_message_id, '444444444444444444');
  assert.equal(payload.summary_message_id, null);
  const [msg] = texts(events, 'postText');
  assert.ok(msg.includes('We agreed the budget'));
  assert.ok(msg.includes(`<${URL_}>`));
  assert.ok(msg.includes(`<t:${EXPIRES}:D>`));
  assert.ok(msg.length <= 2000);
  assert.equal(events[2].replyTo, '444444444444444444');
  assert.ok(!msg.includes('/unshare-transcript'), 'that command is gone');
});

test('a long summary: the Discord message is cut to fit with the link intact, while the saved summary is whole', opt, async () => {
  const { events, payload } = await run({ summary: LONG });
  const msgs = texts(events, 'postText');
  assert.equal(msgs.length, 1, 'one message, not several');
  assert.ok(msgs[0].length <= 2000, `message is ${msgs[0].length}`);
  assert.ok(msgs[0].includes('\n…\n\n🔗'), 'the cut is marked and the link follows');
  assert.ok(msgs[0].endsWith(`<t:${EXPIRES}:D>.`));
  assert.ok(msgs[0].includes(`<${URL_}>`));
  assert.ok(payload.summary_text.length > 4000, 'the stored summary is the full one');
  assert.ok(payload.summary_text.includes('agreed point 69'), 'including the end that Discord does not show');
  assert.ok(!msgs[0].includes('agreed point 69'));
});

test('save off + post on: the summary is posted in full (no link exists), nothing is uploaded', opt, async () => {
  const { events, payload } = await run({ team: { save: false }, summary: LONG });
  assert.equal(payload, null, 'nothing was sent to the Worker');
  assert.deepEqual(types(events).filter((t) => t !== 'postText'), ['postTranscript']);
  const msgs = texts(events, 'postText');
  assert.ok(msgs.length >= 3, 'a long summary needs several messages');
  assert.ok(msgs.every((m) => m.length <= 1900));
  assert.ok(msgs.join('\n').includes('agreed point 69'), 'the whole summary is there');
  assert.ok(!msgs.join('\n').includes('https://'));
});

test('post off + save on: nothing goes to a channel; the starter gets one private message with the summary and link', opt, async () => {
  const { result, events, payload } = await run({ team: { post: false, transcriptChannelId: '', dmUserId: STARTER } });
  assert.equal(result.ok, true);
  assert.deepEqual(types(events), ['upload', 'dm']);
  assert.equal(payload.post_channel_id, VC, 'with nothing posted, the voice channel id stands in');
  assert.equal(payload.transcript_message_id, null);
  const dm = events[1].text;
  assert.ok(dm.includes(`<${URL_}>`));
  assert.ok(dm.length <= 2000);
});

test('post off + save on with nobody to message (a scheduled start): it is still saved, nothing is sent, and the log says why', opt, async () => {
  const { result, events } = await run({ team: { post: false, transcriptChannelId: '', dmUserId: '' } });
  assert.deepEqual(types(events), ['upload']);
  assert.ok(result.notes.some((n) => /nobody started this recording/.test(n)));
  assert.equal(result.stored, true);
});

test('the save failing: the summary is still delivered in full, with a plain note that it was not saved', opt, async () => {
  const { result, events } = await run({ upload: 'fail', summary: SHORT });
  assert.equal(result.stored, false);
  const msgs = texts(events, 'postText');
  assert.ok(msgs[0].includes('We agreed the budget'));
  assert.ok(msgs.at(-1).includes('could not be saved'));
  assert.ok(msgs.at(-1).includes('The file above is the only copy'));
  assert.ok(!msgs.join('\n').includes('https://'));
});

test('the Worker saving without a link (links turned off): the full summary is posted, no empty link line', opt, async () => {
  const { events } = await run({ upload: 'nolink' });
  const msgs = texts(events, 'postText');
  assert.equal(msgs.length, 1);
  assert.ok(!msgs[0].includes('🔗'));
  assert.ok(msgs[0].includes('We agreed the budget'));
});

test('post off and the save failing: the starter is told and gets the transcript file, because nothing else holds it', opt, async () => {
  const { events } = await run({ team: { post: false, transcriptChannelId: '', dmUserId: STARTER }, upload: 'fail' });
  const dms = events.filter((e) => e.type === 'dm');
  assert.ok(dms.some((d) => !d.file && /could not be saved/.test(d.text ?? '')), 'the starter is told it was not saved');
  assert.ok(dms.some((d) => d.file?.startsWith('transcript-')), 'the transcript file itself');
  assert.ok(!types(events).includes('postTranscript'));
});

test('a private message that cannot be delivered (the person blocks DMs) never fails the job', opt, async () => {
  const { result, events } = await run({ team: { post: false, transcriptChannelId: '', dmUserId: STARTER }, dmFails: true });
  assert.equal(result.ok, true);
  assert.equal(result.stored, true);
  assert.deepEqual(types(events), ['upload']);
  assert.ok(result.notes.includes('could not deliver the summary message'));
  assert.ok(!JSON.stringify(result.notes).includes(URL_), 'a note never contains the link');
});
