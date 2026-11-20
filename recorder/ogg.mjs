// Minimal Ogg Opus file writer. Discord delivers Opus packets (20 ms each, 48 kHz, stereo);
// this wraps them in an Ogg container so any player can open the result. No native build needed.
import { openSync, writeSync, closeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const SAMPLES_PER_PACKET = 960; // 20 ms at 48 kHz
const PRE_SKIP = 312;
const MAX_PACKETS_PER_PAGE = 25;

// Ogg uses CRC-32 with polynomial 0x04C11DB7, MSB first, initial value 0, no final xor.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

export function oggCrc(buf) {
  let crc = 0;
  for (const b of buf) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) & 0xff) ^ b]) >>> 0;
  return crc >>> 0;
}

function lacing(len) {
  const out = [];
  let n = len;
  while (n >= 255) {
    out.push(255);
    n -= 255;
  }
  out.push(n);
  return out;
}

export function buildPage({ headerType, granule, serial, seq, packets }) {
  const segs = packets.flatMap((p) => lacing(p.length));
  if (segs.length > 255) throw new Error('too many segments for one Ogg page');
  const header = Buffer.alloc(27 + segs.length);
  header.write('OggS', 0, 'latin1');
  header.writeUInt8(0, 4); // stream structure version
  header.writeUInt8(headerType, 5);
  header.writeBigInt64LE(BigInt(granule), 6);
  header.writeUInt32LE(serial >>> 0, 14);
  header.writeUInt32LE(seq >>> 0, 18);
  header.writeUInt32LE(0, 22); // checksum placeholder
  header.writeUInt8(segs.length, 26);
  segs.forEach((s, i) => header.writeUInt8(s, 27 + i));
  const page = Buffer.concat([header, ...packets]);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

function opusHead(channels = 2, inputRate = 48000) {
  const b = Buffer.alloc(19);
  b.write('OpusHead', 0, 'latin1');
  b.writeUInt8(1, 8); // version
  b.writeUInt8(channels, 9);
  b.writeUInt16LE(PRE_SKIP, 10);
  b.writeUInt32LE(inputRate, 12);
  b.writeInt16LE(0, 16); // output gain
  b.writeUInt8(0, 18); // channel mapping family 0
  return b;
}

function opusTags() {
  const vendor = Buffer.from('voice-recording-test', 'utf8');
  const b = Buffer.alloc(8 + 4 + vendor.length + 4);
  b.write('OpusTags', 0, 'latin1');
  b.writeUInt32LE(vendor.length, 8);
  vendor.copy(b, 12);
  b.writeUInt32LE(0, 12 + vendor.length); // no comments
  return b;
}

export class OggOpusWriter {
  constructor(path) {
    this.fd = openSync(path, 'w');
    this.serial = randomBytes(4).readUInt32LE(0);
    this.seq = 0;
    this.pending = [];
    this.totalSamples = PRE_SKIP;
    this.packetCount = 0;
    this.closed = false;
    this.bytes = 0; // file size so far, used to start a new file before Discord's attachment limit
    this.#write(buildPage({ headerType: 0x02, granule: 0, serial: this.serial, seq: this.seq++, packets: [opusHead()] }));
    this.#write(buildPage({ headerType: 0x00, granule: 0, serial: this.serial, seq: this.seq++, packets: [opusTags()] }));
  }

  #write(buf) {
    writeSync(this.fd, buf);
    this.bytes += buf.length;
  }

  /** Adds one Opus packet (one 20 ms frame from Discord). */
  writePacket(buf) {
    if (this.closed) return;
    const segCount = this.pending.reduce((n, p) => n + lacing(p.length).length, 0) + lacing(buf.length).length;
    if (this.pending.length >= MAX_PACKETS_PER_PAGE || segCount > 255) this.#flush(0x00);
    this.pending.push(Buffer.from(buf));
    this.packetCount++;
    this.totalSamples += SAMPLES_PER_PACKET;
  }

  #flush(headerType) {
    // Granule position of a page = total samples up to the end of its last packet.
    const granule = this.totalSamples; // already counts every packet in this page
    this.#write(buildPage({ headerType, granule, serial: this.serial, seq: this.seq++, packets: this.pending }));
    this.pending = [];
  }

  close() {
    if (this.closed) return;
    this.#flush(0x04); // last page; may be empty if the file has no audio
    this.closed = true;
    closeSync(this.fd);
  }
}
