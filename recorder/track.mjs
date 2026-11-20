// One continuous, time-aligned audio file per speaker.
// Discord only sends packets while someone is talking. We fill the quiet stretches with Opus
// silence so every speaker's file starts at the same moment and keeps real time. Opening two
// speakers' files side by side then plays the conversation in sync, overlaps included.
import path from 'node:path';
import { OggOpusWriter } from './ogg.mjs';

export const FRAME_MS = 20;
// A valid 20 ms Opus silence frame (the same one Discord clients send).
export const SILENCE = Buffer.from([0xf8, 0xff, 0xfe]);

/**
 * How many silent frames to insert before the next packet so it lands at the right moment.
 * Small timing wobble (up to `slack` frames) is ignored; anything bigger is filled.
 * Because we compare against the absolute clock, errors can never build up over a long run.
 */
export function silenceFramesNeeded({ nowMs, startMs, written, slack = 2 }) {
  const expected = Math.floor((nowMs - startMs) / FRAME_MS);
  const gap = expected - written;
  return gap > slack ? gap : 0;
}

export class AlignedTrack {
  constructor({ dir, label, startMs, rotateBytes = 9_000_000, maxSeconds = 1800 }) {
    this.dir = dir;
    this.label = label;
    this.startMs = startMs;
    this.rotateBytes = rotateBytes;
    this.written = 0; // frames written so far, silence included
    this.writer = null;
    this.index = 0;
    this.files = [];
    this.packets = 0;
    this.finished = false;
    // One flag per 20 ms slot: was this speaker audible then? Used to measure overlap.
    this.active = new Uint8Array(Math.ceil((maxSeconds * 1000) / FRAME_MS) + 500);
  }

  #open() {
    this.index++;
    const file = path.join(this.dir, `${this.label}-${String(this.index).padStart(3, '0')}.ogg`);
    this.writer = new OggOpusWriter(file);
    this.files.push(file);
  }

  #fill(n) {
    if (!this.writer) this.#open();
    for (let i = 0; i < n; i++) this.writer.writePacket(SILENCE);
    this.written += n;
  }

  push(packet, nowMs) {
    if (this.finished) return; // a late packet after the run ended must not reopen a file
    const gap = silenceFramesNeeded({ nowMs, startMs: this.startMs, written: this.written });
    if (gap) this.#fill(gap);
    if (!this.writer) this.#open();
    this.writer.writePacket(packet);
    this.packets++;
    const slot = Math.floor((nowMs - this.startMs) / FRAME_MS);
    if (slot >= 0 && slot < this.active.length) this.active[slot] = 1;
    this.written++;
    if (this.writer.bytes >= this.rotateBytes) this.#closeWriter(); // next packet starts a new file
  }

  #closeWriter() {
    if (this.writer) this.writer.close();
    this.writer = null;
  }

  /** Pads with silence up to the end of the run so every speaker's file has the same length. */
  finish(endMs) {
    if (this.finished) return;
    this.finished = true;
    const total = Math.floor((endMs - this.startMs) / FRAME_MS);
    if (total > this.written) this.#fill(total - this.written);
    this.#closeWriter();
  }
}

/** Seconds during which two or more speakers were audible at the same time. */
export function overlapSeconds(tracks) {
  if (tracks.length < 2) return 0;
  const n = Math.min(...tracks.map((t) => t.active.length));
  let slots = 0;
  for (let i = 0; i < n; i++) {
    let c = 0;
    for (const t of tracks) c += t.active[i];
    if (c >= 2) slots++;
  }
  return (slots * FRAME_MS) / 1000;
}
