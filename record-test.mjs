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
import { parseConfig, verdict, logSummary, discordReport } from './lib.mjs';
import { AlignedTrack, overlapSeconds } from './track.mjs';

const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const OUT_DIR = process.env.OUT_DIR || 'recordings';
const MAX_ATTACHMENTS_PER_MESSAGE = 10;
const MAX_ATTACHMENT_BYTES = 9_900_000; // Discord's default upload limit is 10 MiB

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
  let stopping = false;
  let recStartMs = Date.now();

  function startStream(userId) {
    const sp = speakers.get(userId);
    if (stopping || sp.active) return;
    sp.active = true;
    sp.streams++;

    // Manual end: one stream for the whole run, resubscribed at once if it closes or errors. Before, a stream
    // that died while the person kept talking stayed dead until Discord next said "speaking start", so
    // overlapping speech was dropped.
    const stream = connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
    sp.stream = stream;
    const finish = () => {
      if (sp.stream !== stream) return;
      sp.stream = null;
      sp.active = false;
      if (!stopping) setTimeout(() => startStream(userId), 0);
    };
    stream.on('data', (chunk) => {
      sp.packets++;
      sp.track.push(chunk, Date.now());
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

  let endMs = Date.now();
  if (readyMs != null) {
    recStartMs = Date.now(); // all speakers' files are aligned to this moment
    connection.receiver.speaking.on('start', (userId) => {
      if (!speakers.has(userId)) {
        const label = `speaker-${speakers.size + 1}`;
        speakers.set(userId, {
          userId,
          label,
          track: new AlignedTrack({ dir: OUT_DIR, label, startMs: recStartMs, maxSeconds: cfg.durationSec + 60 }),
          packets: 0,
          speakingEvents: 0,
          errors: 0,
          errorKinds: {},
          streams: 0,
          active: false,
        });
      }
      speakers.get(userId).speakingEvents++;
      startStream(userId);
    });

    log(`recording for ${cfg.durationSec} s. Speak in the voice channel now.`);
    while (Date.now() - recStartMs < cfg.durationSec * 1000) {
      await sleep(Math.min(15_000, cfg.durationSec * 1000 - (Date.now() - recStartMs)));
      const total = [...speakers.values()].reduce((n, s) => n + s.packets, 0);
      log(`t=${Math.round((Date.now() - recStartMs) / 1000)} s: ${speakers.size} speaker(s), ${total} packets so far`);
    }
  }

  // ---- stop ---------------------------------------------------------------------------------
  stopping = true;
  endMs = Date.now();
  for (const s of speakers.values()) s.stream?.destroy();
  connection.destroy();
  await sleep(500);
  const all = [...speakers.values()];
  for (const sp of all) sp.track.finish(endMs); // pads every file to the same length

  const stats = {
    readyMs,
    overlapSec: overlapSeconds(all.map((sp) => sp.track)),
    speakers: all.map((s) => ({
      label: s.label,
      packets: s.packets,
      speakingEvents: s.speakingEvents,
      errors: s.errors,
      errorKinds: s.errorKinds,
      streams: s.streams,
      fileCount: s.track.files.length,
      files: s.track.files,
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
      const all_files = stats.speakers.flatMap((s) => s.files).map((f) => ({ f, size: statSync(f).size }));
      const tooBig = all_files.filter((x) => x.size > MAX_ATTACHMENT_BYTES);
      const files = all_files
        .filter((x) => x.size <= MAX_ATTACHMENT_BYTES)
        .map((x) => ({ attachment: x.f, name: path.basename(x.f) }));
      let content = discordReport(stats, v, names);
      if (tooBig.length) content += `\nNot attached (over the upload limit): ${tooBig.map((x) => path.basename(x.f)).join(', ')}. Saved on the machine that ran the test.`;
      content = content.slice(0, 1990); // Discord rejects messages over 2,000 characters
      const batches = [];
      for (let i = 0; i < files.length; i += MAX_ATTACHMENTS_PER_MESSAGE) batches.push(files.slice(i, i + MAX_ATTACHMENTS_PER_MESSAGE));
      if (batches.length === 0) batches.push([]);
      for (let i = 0; i < batches.length; i++) {
        await target.send({ content: i === 0 ? content : `(more clips, part ${i + 1} of ${batches.length})`, files: batches[i] });
      }
      log(`posted the report and ${files.length} file(s) to the test channel`);
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
