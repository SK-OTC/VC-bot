// Production recorder: joins a team's voice channel, records every speaker, and when the meeting ends
// transcribes it, posts transcript + summary to that team's private channel, and stores it for /transcript.
// Runs inside a GitHub Actions job started by the Cloudflare Worker (or by hand). Logs show counts only.
import { Client, GatewayIntentBits, Events, ChannelType } from 'discord.js';
import { joinVoiceChannel, entersState, VoiceConnectionStatus, EndBehaviorType } from '@discordjs/voice';
import { mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseSessionConfig } from './recorder/config.mjs';
import { reportFinish } from './recorder/report.mjs';
import { fetchRemoteTeam } from './recorder/remote-config.mjs';
import { shouldStop, trackEmpty, recordingNickname, batchAttachments } from './recorder/stop.mjs';
import { finishSession } from './recorder/session.mjs';
import { AlignedTrack } from './track.mjs';
import { GroqEngine } from './pipeline/groq.mjs';
import { LocalEngine } from './pipeline/local.mjs';
import { ChatClient } from './pipeline/summary.mjs';

const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const OUT_DIR = process.env.OUT_DIR || 'recordings';
const NOMENTIONS = { parse: [] }; // transcript text must never ping anyone

process.on('unhandledRejection', (e) => log(`unhandled rejection: ${e?.message ?? e}`));

async function retry(fn, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < tries) await sleep(1500 * i);
    }
  }
  throw last;
}

async function pollStopFlag(cfg) {
  if (!cfg.workerUrl || !cfg.workerSecret || !cfg.sessionId) return false;
  try {
    const res = await fetch(`${cfg.workerUrl}/api/sessions/${encodeURIComponent(cfg.sessionId)}/stop`, {
      headers: { Authorization: `Bearer ${cfg.workerSecret}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    return (await res.json()).stop === true;
  } catch {
    return false; // a failed poll never stops a meeting
  }
}

async function main() {
  const remote = await fetchRemoteTeam(process.env);
  const cfg = parseSessionConfig(process.env, remote.found ? remote.team : null);
  log(remote.found ? 'recording settings: from /setup-recording' : `recording settings: from TEAM_CONFIG (${remote.reason})`);
  mkdirSync(OUT_DIR, { recursive: true });
  log(`node ${process.version}; team config found; limit ${cfg.maxMinutes} min`);

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates], allowedMentions: NOMENTIONS });
  const ready = new Promise((r) => client.once(Events.ClientReady, r));
  await client.login(cfg.token);
  await ready;

  const channel = await client.channels.fetch(cfg.channelId);
  if (!channel || channel.type !== ChannelType.GuildVoice) throw new Error('CHANNEL_ID is not a normal voice channel');
  if (!channel.joinable) throw new Error('The bot cannot join that channel (needs View Channel and Connect, and the channel must not be full)');
  const guild = channel.guild;
  const me = guild.members.me ?? (await guild.members.fetchMe());
  if (me.voice.channelId) throw new Error('The bot is already in a voice channel in this server (one recording at a time per bot per server)');

  const target = await client.channels.fetch(cfg.team.transcriptChannelId);
  if (!target?.isTextBased() || target.guildId !== guild.id) throw new Error('transcriptChannelId must be a text channel in the same server as the voice channel');
  const backup = cfg.team.backupChannelId ? await client.channels.fetch(cfg.team.backupChannelId) : null;
  if (backup && (!backup.isTextBased() || backup.guildId !== guild.id)) throw new Error('backupChannelId must be a text channel in the same server');

  // ---- tell people they are being recorded (required) ---------------------------------------
  const originalNick = me.nickname;
  let nickChanged = false;
  let noticeSent = false;
  try {
    await me.setNickname(recordingNickname(me.displayName));
    nickChanged = true;
  } catch (e) {
    log(`could not change the bot's nickname (${e.code || e.message})`);
  }
  try {
    await channel.send({ content: '🔴 **This voice channel is being recorded and transcribed.** The transcript and a summary go to the team\'s private transcript channel. Leave the channel if you do not agree.', allowedMentions: NOMENTIONS });
    noticeSent = true;
  } catch (e) {
    log(`could not post the notice in the voice channel chat (${e.code || e.message})`);
  }
  const restoreNick = async () => {
    if (!nickChanged) return;
    nickChanged = false;
    await me.setNickname(originalNick ?? null).catch(() => {});
  };
  if (!nickChanged && !noticeSent) {
    throw new Error('Refusing to record: the bot could neither rename itself nor post a notice. Give it Change Nickname and Send Messages in the voice channel.');
  }

  // ---- join ------------------------------------------------------------------------------------
  const connection = joinVoiceChannel({ channelId: channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: true });
  let aborted = false;
  const abort = async (sig) => {
    if (aborted) return;
    aborted = true;
    log(`received ${sig}: leaving without a transcript (use /stop-recording to end a meeting normally)`);
    connection.destroy();
    await restoreNick();
    await reportFinish(process.env, 'failed', `cancelled (${sig}); no transcript`);
    process.exit(130);
  };
  process.on('SIGINT', () => abort('SIGINT'));
  process.on('SIGTERM', () => abort('SIGTERM'));

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, cfg.readyTimeoutSec * 1000);
  } catch {
    connection.destroy();
    await restoreNick();
    throw new Error(`could not connect to voice within ${cfg.readyTimeoutSec} s (last state: ${connection.state.status})`);
  }
  const recStartMs = Date.now();
  log('connected; recording');

  // ---- record ----------------------------------------------------------------------------------
  const speakers = new Map();
  let stopping = false;
  const humansNow = () => channel.members.filter((m) => !m.user.bot).size;
  const state = { joinedAt: recStartMs, firstHumanAt: null, emptySince: null, lastSpeechAt: null, stopFlag: false };

  function startStream(sp) {
    if (stopping || sp.active) return;
    sp.active = true;
    // Manual end: the stream lives for the whole meeting. With AfterSilence (or after a stream error) the
    // stream died, and nothing restarted it until Discord next reported "speaking start", so anyone who
    // kept talking (overlapping speech) was silently dropped. We resubscribe at once if it ever closes.
    const stream = connection.receiver.subscribe(sp.userId, { end: { behavior: EndBehaviorType.Manual } });
    sp.stream = stream;
    const done = () => {
      if (sp.stream !== stream) return;
      sp.stream = null;
      sp.active = false;
      if (!stopping) setTimeout(() => startStream(sp), 0);
    };
    stream.on('data', (chunk) => {
      sp.packets++;
      sp.track.push(chunk, Date.now());
    });
    stream.on('error', () => {
      sp.errors++;
      done();
    });
    stream.on('end', done);
    stream.on('close', done);
  }

  connection.receiver.speaking.on('start', (userId) => {
    const member = channel.members.get(userId);
    if (member?.user.bot) return; // music bots and the like are not part of the meeting
    state.lastSpeechAt = Date.now();
    let sp = speakers.get(userId);
    if (!sp) {
      const label = `speaker-${speakers.size + 1}`;
      sp = { userId, label, name: member?.displayName ?? null, packets: 0, errors: 0, active: false, track: new AlignedTrack({ dir: OUT_DIR, label, startMs: recStartMs, maxSeconds: (cfg.startWaitMinutes + cfg.maxMinutes) * 60 + 600 }) };
      speakers.set(userId, sp);
    }
    startStream(sp);
  });

  let stopInfo = { stop: false };
  let lastFlagCheck = 0;
  let lastLog = Date.now();
  while (!stopInfo.stop) {
    await sleep(5000);
    const now = Date.now();
    const humans = humansNow();
    if (humans > 0 && state.firstHumanAt == null) {
      state.firstHumanAt = now;
      log('first person detected; timestamps start now');
    }
    state.emptySince = state.firstHumanAt == null ? null : trackEmpty(state.emptySince, humans, now);
    if (now - lastFlagCheck >= 15_000) {
      lastFlagCheck = now;
      state.stopFlag = (await pollStopFlag(cfg)) || state.stopFlag;
    }
    stopInfo = shouldStop({ ...state, now, humans }, cfg);
    if (connection.state.status === VoiceConnectionStatus.Destroyed) stopInfo = { stop: true, reason: 'the voice connection was closed' };
    if (now - lastLog >= 5 * 60_000) {
      lastLog = now;
      log(`t=${Math.round((now - recStartMs) / 60000)} min: ${humans} person(s) in channel, ${speakers.size} speaker(s) heard`);
    }
  }
  stopping = true;
  const endMs = Date.now();
  log(`stopping: ${stopInfo.reason}`);
  for (const sp of speakers.values()) sp.stream?.destroy();
  connection.destroy();
  await restoreNick();
  await sleep(500);

  // ---- nobody came -------------------------------------------------------------------------
  if (stopInfo.empty || speakers.size === 0) {
    await retry(() => target.send({ content: `Recording ended: ${stopInfo.reason}. No speech was captured, so there is no transcript.`, allowedMentions: NOMENTIONS })).catch(() => {});
    await client.destroy();
    await reportFinish(process.env, 'done', 'no speech captured');
    return rmSync(OUT_DIR, { recursive: true, force: true });
  }

  for (const sp of speakers.values()) sp.track.finish(endMs);
  for (const sp of speakers.values()) {
    const m = await guild.members.fetch(sp.userId).catch(() => null);
    if (m) sp.name = m.displayName;
  }
  const speakerList = [...speakers.values()].map((sp) => ({ label: sp.label, name: sp.name, files: sp.track.files }));
  log(`${speakerList.length} speaker(s), ${speakerList.reduce((n, s) => n + s.files.length, 0)} file(s); transcribing`);

  // ---- engines -------------------------------------------------------------------------------
  const engine = cfg.groqKey
    ? new GroqEngine({ apiKey: cfg.groqKey, model: process.env.GROQ_MODEL || 'whisper-large-v3', language: cfg.team.language })
    : { name: 'none', transcribe: async () => { throw Object.assign(new Error('GROQ_API_KEY is not set'), { kind: 'auth' }); } };
  const fallbackEngine = process.env.USE_LOCAL_FALLBACK === '0' ? null : new LocalEngine({ language: cfg.team.language });
  const chat = cfg.groqKey ? new ChatClient({ apiKey: cfg.groqKey, model: process.env.LLM_MODEL || 'openai/gpt-oss-120b' }) : null;

  const reply = (replyTo) => (replyTo ? { reply: { messageReference: replyTo, failIfNotExists: false } } : {});
  const io = {
    postTranscript: async ({ content, file }) => {
      const msg = await retry(() => target.send({ content, files: [{ attachment: file.data, name: file.name }], allowedMentions: NOMENTIONS }));
      return { messageId: msg.id };
    },
    postText: async (text, { replyTo } = {}) => {
      const msg = await retry(() => target.send({ content: text, allowedMentions: NOMENTIONS, ...reply(replyTo) }));
      return { messageId: msg.id };
    },
    postBackup: async (content, files) => {
      await retry(() => backup.send({ content, files: files.map((f) => ({ attachment: f.path, name: f.name })), allowedMentions: NOMENTIONS }));
    },
  };

  const offsetSec = Math.max(0, ((state.firstHumanAt ?? recStartMs) - recStartMs) / 1000);
  let result;
  try {
    result = await finishSession({
      speakers: speakerList,
      offsetSec,
      startedAt: state.firstHumanAt ?? recStartMs,
      cfg,
      engine,
      fallbackEngine,
      chat,
      io,
      log,
      sessionId: cfg.sessionId,
      voiceChannelId: channel.id,
      guildId: guild.id,
    });
  } catch (e) {
    // Never lose a meeting's audio because the transcription step broke: put the audio in the backup channel if there is one.
    log(`transcription step failed: ${e.message}`);
    let rescued = false;
    if (backup) {
      const files = speakerList.flatMap((sp) => sp.files).map((f) => ({ path: f, name: path.basename(f), size: statSync(f).size }));
      const { batches } = batchAttachments(files);
      try {
        for (let i = 0; i < batches.length; i++) await io.postBackup(`Rescued audio (part ${i + 1} of ${batches.length}). Speaker numbers: ${speakerList.map((sp) => sp.label).join(', ')}.`, batches[i]);
        rescued = batches.length > 0;
      } catch (err) {
        log(`rescue upload failed: ${err.message}`);
      }
    }
    await retry(() => target.send({ content: `Transcription failed (${String(e.message).slice(0, 150)}). ${rescued ? 'The audio was saved to the backup channel so it can be transcribed later.' : 'The audio could not be saved and is gone.'}`, allowedMentions: NOMENTIONS })).catch(() => {});
    rmSync(OUT_DIR, { recursive: true, force: true });
    await client.destroy();
    await reportFinish(process.env, 'failed', 'transcription failed');
    process.exit(3);
  }
  log(`done: ${JSON.stringify({ id: result.id, speakers: result.stats.speakers, batches: result.stats.batches, failed: result.stats.failed, fallback: result.stats.fallback, summarised: result.summarised, stored: result.stored })}`);
  for (const n of result.notes) log(`note: ${n}`);

  rmSync(OUT_DIR, { recursive: true, force: true });
  await client.destroy();
  await reportFinish(process.env, 'done'); // already 'done' if the transcript was stored; this covers "storage not configured"
  process.exit(0);
}

main().catch(async (e) => {
  console.error(`ERROR: ${e.message}`);
  await reportFinish(process.env, 'failed', e.message);
  try {
    if (readdirSync(OUT_DIR).length) console.error('Audio files from this run are being discarded with the machine.');
  } catch {}
  process.exit(2);
});
