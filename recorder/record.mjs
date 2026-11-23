// Production recorder: joins a team's voice channel, records every speaker, and when the meeting ends
// transcribes it, posts transcript + summary to that team's private channel, and stores it for /transcript.
// Runs inside a GitHub Actions job started by the Cloudflare Worker (or by hand). Logs show counts only.
import { Client, GatewayIntentBits, Events, ChannelType, PermissionFlagsBits } from 'discord.js';
import { joinVoiceChannel, entersState, VoiceConnectionStatus, EndBehaviorType } from '@discordjs/voice';
import { mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseSessionConfig } from './config.mjs';
import { reportFinish } from './report.mjs';
import { fetchRemoteTeam } from './remote-config.mjs';
import { shouldStop, trackEmpty, recordingNickname, batchAttachments } from './stop.mjs';
import { finishSession } from './session.mjs';
import { AlignedTrack } from './track.mjs';
import { planEngines } from '../pipeline/engines.mjs';
import { buildSummaryProviders } from '../pipeline/providers.mjs';
import { fetchSummaryBudget } from '../pipeline/budget.mjs';

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
  if (remote.ended) {
    // A re-run (or second copy) of a job whose session is over: recording again would post the meeting a second time.
    log(`nothing to do: ${remote.reason}`);
    process.exit(0);
  }
  const cfg = parseSessionConfig(process.env, remote.found ? remote.team : null);
  log(remote.found ? 'recording settings: from /recording voice-channel' : `recording settings: from TEAM_CONFIG (${remote.reason})`);
  mkdirSync(OUT_DIR, { recursive: true });
  log(`node ${process.version}; team config found; limit ${cfg.maxMinutes} min`);
  // Transcription engines, in ENGINE_ORDER (default: Parakeet first, Groq Whisper as the fallback). Parakeet starts loading its
  // model now, in the background, so it is ready by the time the meeting ends.
  const enginePlan = planEngines({ env: process.env, language: cfg.team.language, groqKey: cfg.groqKey, log });

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

  // Where results are posted. With posting off (/recording setup name:Default) there is no channel: the summary link goes to whoever started it.
  const target = cfg.team.post ? await client.channels.fetch(cfg.team.transcriptChannelId) : null;
  if (cfg.team.post && (!target?.isTextBased() || target.guildId !== guild.id)) throw new Error('the transcript channel must be a text channel in the same server as the voice channel');
  const backup = cfg.team.backupChannelId ? await client.channels.fetch(cfg.team.backupChannelId) : null;
  if (backup && (!backup.isTextBased() || backup.guildId !== guild.id)) throw new Error('backupChannelId must be a text channel in the same server');
  // The named recording setup's other channels (/recording setup). A problem with one of them never stops a recording: an unusable
  // summary channel means the summary goes with the transcript (finishSession says so there), an unusable link or audio channel
  // means nothing is posted there. Nothing private is ever redirected to some other channel.
  const optionalChannel = async (id, what) => {
    if (!id) return null;
    try {
      const c = await client.channels.fetch(id);
      if (c?.isTextBased() && c.guildId === guild.id) return c;
    } catch {
      // fall through
    }
    log(`warning: the ${what} channel of the recording setup is not a text channel the bot can use in this server; nothing is posted there`);
    return null;
  };
  const summaryTarget = await optionalChannel(cfg.team.summaryChannelId, 'summary');
  const linkTarget = await optionalChannel(cfg.team.linkChannelId, 'recording-link');
  const audioTarget = await optionalChannel(cfg.team.audioChannelId, 'audio');
  const unusable = (what) => async () => {
    throw new Error(`the ${what} channel is not a text channel I can use in this server`);
  };
  if (cfg.team.setupName) log(`recording setup: ${cfg.team.summaryChannelId ? 'separate summary channel' : 'summary with the transcript'}, ${cfg.team.linkChannelId ? 'recording link on' : 'no recording link'}, audio ${cfg.team.audioChannelId ? 'in the private channel' : cfg.team.backupChannelId ? 'in the backup channel' : 'not kept'}`);
  // /recording setup only proves the bot can SEND in the transcript channel. Without Attach Files the transcript file cannot be
  // posted there; finishSession then saves it and sends it another way, but warn now so the log shows why. Never blocks recording.
  try {
    const perms = target?.permissionsFor?.(me);
    if (perms && !perms.has(PermissionFlagsBits.AttachFiles)) log('warning: the bot may not Attach Files in the transcript channel; the transcript file will be sent another way');
  } catch {
    // a permission lookup problem must never stop a recording
  }

  // A private message to whoever started the recording (used when posting is off). Needs the discord.js client; fails quietly
  // if they do not accept messages from this bot (Discord error 50007).
  const sendDm = async (content, file) => {
    const user = await client.users.fetch(cfg.team.dmUserId);
    return user.send({ content, allowedMentions: NOMENTIONS, ...(file ? { files: [{ attachment: file.data, name: file.name }] } : {}) });
  };
  // A short status message for failures: to the channel, or privately when posting is off. Never throws.
  const notify = async (content) => {
    try {
      if (target) await retry(() => target.send({ content, allowedMentions: NOMENTIONS }));
      else if (cfg.team.dmUserId) await sendDm(content);
      else log(`no one to tell: ${content.slice(0, 80)}`);
    } catch (e) {
      log(`could not deliver a status message (${e.code || e.message})`);
    }
  };

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
    const where = !cfg.team.post
      ? 'A summary link will be sent privately to the person who started the recording.'
      : summaryTarget && summaryTarget.id !== target.id
        ? `The transcript will be posted in <#${target.id}> and a summary in <#${summaryTarget.id}>.`
        : `The transcript and a summary will be posted in <#${target.id}>.`;
    await channel.send({ content: `🔴 **This voice channel is being recorded and transcribed.** ${where} Leave the channel if you do not agree.`, allowedMentions: NOMENTIONS });
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
    await notify(`Recording ended: ${stopInfo.reason}. No speech was captured, so there is no transcript.`);
    await client.destroy();
    await enginePlan.close();
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
  const { engine, fallbackEngine } = await enginePlan.resolve();
  // Summary models: Gemma 4 then gpt-oss-120b on Cloudflare, Groq gpt-oss last (SUMMARY_MODEL_ORDER). Ask the Worker whether
  // today's Cloudflare Neuron budget for summaries has room; if it cannot be reached, Cloudflare is simply tried.
  const budget = await fetchSummaryBudget({ workerUrl: cfg.workerUrl, secret: cfg.workerSecret });
  const providers = buildSummaryProviders({ env: process.env, cloudflareAllowed: !budget.known || budget.allowed, log });

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
    dm: async (content, { file } = {}) => {
      const msg = await retry(() => sendDm(content, file));
      return { messageId: msg.id };
    },
    postBackup: async (content, files) => {
      // Audio files come from disk ({ path }); a rescued transcript file comes from memory ({ data }).
      await retry(() => backup.send({ content, files: files.map((f) => ({ attachment: f.data ?? f.path, name: f.name })), allowedMentions: NOMENTIONS }));
    },
    // Named recording setup channels. One that could not be opened above fails every post (finishSession then reports it, and the
    // summary goes with the transcript instead); a setup without the channel leaves the function out.
    ...(cfg.team.summaryChannelId
      ? { postSummary: summaryTarget ? async (text) => ({ messageId: (await retry(() => summaryTarget.send({ content: text, allowedMentions: NOMENTIONS }))).id }) : unusable('summary') }
      : {}),
    ...(cfg.team.linkChannelId ? { postLink: linkTarget ? async (text) => { await retry(() => linkTarget.send({ content: text, allowedMentions: NOMENTIONS })); } : unusable('recording-link') } : {}),
    ...(cfg.team.audioChannelId
      ? {
          postAudio: audioTarget
            ? async (content, files) => { await retry(() => audioTarget.send({ content, files: files.map((f) => ({ attachment: f.data ?? f.path, name: f.name })), allowedMentions: NOMENTIONS })); }
            : unusable('audio'),
        }
      : {}),
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
      budgetSec: cfg.parakeetBudgetMin * 60,
      providers,
      io,
      log,
      sessionId: cfg.sessionId,
      voiceChannelId: channel.id,
      guildId: guild.id,
    });
  } catch (e) {
    // Never lose a meeting's audio because the transcription step broke: put the audio in the setup's private audio channel or the
    // backup channel, if there is one (only ever a channel named for audio).
    log(`transcription step failed: ${e.message}`);
    let rescued = false;
    const rescueTo = audioTarget ? io.postAudio : backup ? io.postBackup : null;
    if (rescueTo) {
      const files = speakerList.flatMap((sp) => sp.files).map((f) => ({ path: f, name: path.basename(f), size: statSync(f).size }));
      const { batches } = batchAttachments(files);
      try {
        for (let i = 0; i < batches.length; i++) await rescueTo(`Rescued audio (part ${i + 1} of ${batches.length}). Speaker numbers: ${speakerList.map((sp) => sp.label).join(', ')}.`, batches[i]);
        rescued = batches.length > 0;
      } catch (err) {
        log(`rescue upload failed: ${err.message}`);
      }
    }
    await notify(`Transcription failed (${String(e.message).slice(0, 150)}). ${rescued ? (audioTarget ? 'The audio was saved to this channel so it can be transcribed later.' : 'The audio was saved to the backup channel so it can be transcribed later.') : 'The audio could not be saved and is gone.'}`);
    rmSync(OUT_DIR, { recursive: true, force: true });
    await client.destroy();
    await enginePlan.close();
    await reportFinish(process.env, 'failed', 'transcription failed');
    process.exit(3);
  }
  log(`done: ${JSON.stringify({ id: result.id, speakers: result.stats.speakers, batches: result.stats.batches, failed: result.stats.failed, fallback: result.stats.fallback, summarised: result.summarised, stored: result.stored })}`);
  for (const n of result.notes) log(`note: ${n}`);

  if (result.lost) {
    // Not posted, not saved, not sent anywhere: say so where possible and mark the run failed, so it does not look fine.
    await notify(`The ${cfg.team.name} transcript could not be posted, saved or sent anywhere, so it is gone. Check that I may Attach Files in the transcript channel.`);
  }
  rmSync(OUT_DIR, { recursive: true, force: true });
  await client.destroy();
  await enginePlan.close();
  // 'done' is usually already reported when the transcript was stored; this also covers "storage not configured".
  await reportFinish(process.env, result.lost ? 'failed' : 'done', result.lost ? 'the transcript could not be posted, saved or sent' : '');
  process.exit(result.lost ? 3 : 0);
}

main().catch(async (e) => {
  console.error(`ERROR: ${e.message}`);
  await reportFinish(process.env, 'failed', e.message);
  try {
    if (readdirSync(OUT_DIR).length) console.error('Audio files from this run are being discarded with the machine.');
  } catch {}
  process.exit(2);
});
