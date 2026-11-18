// Voice recording feasibility test.
// Joins one Discord voice channel, records one Opus track per speaker for a fixed time,
// then reports PASS / WARN / FAIL. It prints only counts to the log (public repos have public logs)
// and posts the clips to a private text channel so you can listen to them.
import { Client, GatewayIntentBits, Events, ChannelType } from 'discord.js';
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  EndBehaviorType,
  generateDependencyReport,
} from '@discordjs/voice';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseConfig, verdict, logSummary, discordReport, silenceFramesNeeded, SILENCE_FRAME } from './lib.mjs';
import { OggOpusWriter } from './ogg.mjs';

const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const OUT_DIR = process.env.OUT_DIR || 'recordings';
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 8_000_000;

process.on('unhandledRejection', (e) => log(`unhandled rejection: ${e?.message ?? e}`));

/** Short, log-safe description of a stream error (never includes audio or ids). */
function errorKind(err) {
  const m = /DecryptionFailed\(([^)]*)\)/.exec(err?.message ?? '');
  if (m) return `DecryptionFailed(${m[1]})`;
  return String(err?.name || err?.message || 'error').slice(0, 60);
}

async function main() {
  const cfg = parseConfig(process.env);
  mkdirSync(OUT_DIR, { recursive: true });

  log(`node ${process.version} on ${process.platform}/${process.arch}`);
  console.log(generateDependencyReport());

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  const ready = new Promise((resolve) => client.once(Events.ClientReady, resolve));
  await client.login(cfg.token);
  await ready;
  log('logged in to Discord');

  const channel = await client.channels.fetch(cfg.channelId);
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    throw new Error('CHANNEL_ID is not a normal voice channel (stage channels are not supported by this test)');
  }
  if (!channel.joinable) {
    throw new Error('The bot cannot join that channel: it needs View Channel and Connect, and the channel must not be full');
  }

  // ---- join ---------------------------------------------------------------------------------
  const t0 = Date.now();
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false, // must be false or Discord sends us nothing
    selfMute: true,
  });
  let disconnects = 0;
  connection.on('stateChange', (o, n) => {
    log(`voice connection: ${o.status} -> ${n.status}`);
    if (n.status === VoiceConnectionStatus.Disconnected) disconnects++;
  });
  if (process.env.DEBUG_VOICE === '1') connection.on('debug', (m) => log(`debug: ${m}`)); // may show server addresses

  let readyMs = null;
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, cfg.readyTimeoutSec * 1000);
    readyMs = Date.now() - t0;
    log(`connected in ${(readyMs / 1000).toFixed(1)} s`);
  } catch {
    log(`did not reach the connected state within ${cfg.readyTimeoutSec} s (last state: ${connection.state.status})`);
  }

  // ---- record -------------------------------------------------------------------------------
  const speakers = new Map(); // userId -> state
  const openWriters = new Set();
  let stopping = false;

  let recordStart = Date.now();

  // One subscription and ONE file per speaker for the whole run. Previously each pause > 1.5 s ended the
  // stream, and a stream error killed it until Discord sent a fresh "speaking start". Anyone who kept
  // talking (e.g. overlapping speech) was then silently dropped. Now we never end the stream ourselves
  // and we resubscribe at once if it dies.
  function startStream(userId) {
    const sp = speakers.get(userId);
    if (stopping || sp.active) return;
    sp.active = true;

    const stream = connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      sp.active = false;
      if (!stopping) setTimeout(() => startStream(userId), 50); // resubscribe immediately
    };
    stream.on('data', (chunk) => {
      sp.packets++;
      if (!sp.writer) {
        sp.file = path.join(OUT_DIR, `${sp.label}.ogg`);
        sp.writer = new OggOpusWriter(sp.file);
        sp.parts = 1;
        openWriters.add(sp.writer);
        sp.files.push(sp.file);
        sp.written = 0;
        sp.trackStart = recordStart; // every track starts at the same instant, so they line up
      }
      // Fill gaps (silence, lost or undecryptable packets) with silence so timing stays correct.
      const pad = silenceFramesNeeded(sp.written, Date.now(), sp.trackStart);
      for (let i = 0; i < pad; i++) sp.writer.writePacket(SILENCE_FRAME);
      sp.written += pad;
      sp.silenceFrames += pad;
      sp.writer.writePacket(chunk);
      sp.written++;
    });
    stream.on('error', (err) => {
      sp.errors++;
      const kind = errorKind(err);
      sp.errorKinds[kind] = (sp.errorKinds[kind] || 0) + 1;
      finish();
    });
    stream.on('end', finish);
    stream.on('close', finish);
  }

  if (readyMs != null) {
    connection.receiver.speaking.on('start', (userId) => {
      if (!speakers.has(userId)) {
        speakers.set(userId, {
          userId,
          label: `speaker-${speakers.size + 1}`,
          packets: 0,
          speakingEvents: 0,
          errors: 0,
          errorKinds: {},
          parts: 0,
          files: [],
          active: false,
          writer: null,
          file: null,
          written: 0,
          silenceFrames: 0,
          trackStart: 0,
        });
      }
      speakers.get(userId).speakingEvents++;
      startStream(userId);
    });

    log(`recording for ${cfg.durationSec} s. Speak in the voice channel now.`);
    const started = Date.now();
    recordStart = started;
    while (Date.now() - started < cfg.durationSec * 1000) {
      await sleep(Math.min(15_000, cfg.durationSec * 1000 - (Date.now() - started)));
      const total = [...speakers.values()].reduce((n, s) => n + s.packets, 0);
      log(`t=${Math.round((Date.now() - started) / 1000)} s: ${speakers.size} speaker(s), ${total} packets so far`);
    }
  }

  // ---- stop ---------------------------------------------------------------------------------
  stopping = true;
  connection.destroy();
  await sleep(1500);
  for (const w of openWriters) w.close();
  openWriters.clear();

  const stats = {
    readyMs,
    speakers: [...speakers.values()].map((s) => ({
      label: s.label,
      packets: s.packets,
      speakingEvents: s.speakingEvents,
      errors: s.errors,
      errorKinds: s.errorKinds,
      parts: s.parts,
      files: s.files,
    })),
  };
  const v = verdict(stats, cfg.minPackets);
  console.log('\n' + logSummary(stats, v) + `\nvoice disconnects during the run: ${disconnects}\n`);

  // ---- report to the private channel ---------------------------------------------------------
  if (!cfg.postChannelId) {
    log('POST_CHANNEL_ID is not set, so no clips were posted. Set it to hear the recordings.');
  } else {
    try {
      const names = {};
      for (const s of speakers.values()) {
        const m = await channel.guild.members.fetch(s.userId).catch(() => null);
        if (m) names[s.label] = m.displayName;
      }
      const target = await client.channels.fetch(cfg.postChannelId);
      if (!target?.isTextBased()) throw new Error('POST_CHANNEL_ID is not a text channel');
      const files = stats.speakers
        .flatMap((s) => s.files)
        .map((f) => ({ f, size: statSync(f).size }))
        .filter((x) => x.size > 1000 && x.size <= MAX_ATTACHMENT_BYTES)
        .sort((a, b) => b.size - a.size)
        .slice(0, MAX_ATTACHMENTS)
        .map((x) => ({ attachment: x.f, name: path.basename(x.f) }));
      await target.send({ content: discordReport(stats, v, names), files });
      log(`posted the report and ${files.length} clip(s) to the test channel`);
    } catch (e) {
      log(`could not post to the test channel: ${e.message}`);
    }
  }

  await client.destroy();
  process.exit(v.status === 'FAIL' ? 1 : 0);
}

main().catch((e) => {
  console.error(`ERROR: ${e.message}`);
  process.exit(2);
});
