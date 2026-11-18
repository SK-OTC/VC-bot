import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, createReadStream, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { OggOpusWriter, oggCrc, buildPage } from '../ogg.mjs';

const require = createRequire(import.meta.url);
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

test('oggCrc matches the known Ogg checksum of an empty-ish page', () => {
  // A page built by buildPage must verify: recompute CRC with the checksum field zeroed.
  const page = buildPage({ headerType: 0x02, granule: 0, serial: 1, seq: 0, packets: [Buffer.from('hello')] });
  const stored = page.readUInt32LE(22);
  const copy = Buffer.from(page);
  copy.writeUInt32LE(0, 22);
  assert.equal(oggCrc(copy), stored);
});

test('lacing: a 255-byte packet needs a terminating zero segment', () => {
  const page = buildPage({ headerType: 0, granule: 0, serial: 1, seq: 0, packets: [Buffer.alloc(255, 1)] });
  assert.equal(page.readUInt8(26), 2); // two segments
  assert.equal(page.readUInt8(27), 255);
  assert.equal(page.readUInt8(28), 0);
});

test('round trip: ffmpeg-made Opus packets rewritten by our writer decode cleanly and keep their length', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ogg-test-'));
  const src = path.join(dir, 'src.ogg');
  const out = path.join(dir, 'out.ogg');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-ac', '2', '-ar', '48000', '-c:a', 'libopus', '-frame_duration', '20', '-b:a', '32k', src]);

  // Pull the raw Opus packets out of the source file (prism-media is a dev-only helper for this test).
  const prism = require('prism-media');
  const packets = [];
  await new Promise((resolve, reject) => {
    const demux = new prism.opus.OggDemuxer();
    createReadStream(src).pipe(demux);
    demux.on('data', (p) => packets.push(Buffer.from(p)));
    demux.on('end', resolve);
    demux.on('error', reject);
  });
  assert.ok(packets.length > 100, `expected about 150 packets, got ${packets.length}`);

  const w = new OggOpusWriter(out);
  for (const p of packets) w.writePacket(p);
  w.close();
  assert.ok(existsSync(out));

  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,channels,sample_rate:format=duration', '-of', 'json', out]).toString());
  assert.equal(probe.streams[0].codec_name, 'opus');
  assert.equal(probe.streams[0].channels, 2);
  const seconds = Number(probe.format.duration);
  assert.ok(Math.abs(seconds - packets.length * 0.02) < 0.1, `duration ${seconds}s vs ${packets.length * 0.02}s expected`);

  // A full decode must produce no errors (this validates every page checksum and the lacing).
  const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 'null', '-']);
  assert.equal(dec.status, 0);
  assert.equal(dec.stderr.toString().trim(), '');
});

test('closing a writer that never received a packet does not throw', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ogg-empty-'));
  const w = new OggOpusWriter(path.join(dir, 'empty.ogg'));
  assert.doesNotThrow(() => w.close());
  assert.doesNotThrow(() => w.close()); // closing twice is harmless
  assert.doesNotThrow(() => w.writePacket(Buffer.from([1, 2, 3]))); // writes after close are ignored
});
