// The daily Cloudflare Neuron meter (see migrations/0010_ai_meter.sql). Numbers only: nothing here sees any text.
import { utcDay } from './neurons.js';

export const DEFAULT_QA_SOFT_CAP = 7000; // Q&A is allowed only while today's total is under this
export const DEFAULT_SUMMARY_SOFT_CAP = 9500; // summaries are allowed under this (they matter more, so the cap is higher)
const KINDS = { summary: 'summary', qa: 'qa', embed: 'embed' }; // a whitelist: the kind becomes a column name below
const KEEP_DAYS = 35;

const capOf = (value, fallback) => {
  const s = String(value ?? '').trim();
  if (s === '') return fallback;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 1_000_000 ? n : fallback;
};

/** QA_SOFT_CAP and SUMMARY_SOFT_CAP (Neurons). */
export function softCaps(env) {
  return { qa: capOf(env?.QA_SOFT_CAP, DEFAULT_QA_SOFT_CAP), summary: capOf(env?.SUMMARY_SOFT_CAP, DEFAULT_SUMMARY_SOFT_CAP) };
}

/** Adds Neurons to today's meter. Atomic (one statement), ignores zero, negative and non-numeric amounts. */
export async function addNeurons(db, kind, neurons, nowSec) {
  const column = KINDS[kind];
  const n = Number(neurons);
  if (!column || !Number.isFinite(n) || n <= 0) return;
  await db
    .prepare(
      `INSERT INTO ai_neurons (day, ${column}, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (day) DO UPDATE SET ${column} = ${column} + excluded.${column}, updated_at = excluded.updated_at`,
    )
    .bind(utcDay(nowSec), n, nowSec)
    .run();
  await db.prepare('DELETE FROM ai_neurons WHERE day < ?').bind(utcDay(nowSec - KEEP_DAYS * 86_400)).run();
}

/** Today's totals: { day, summary, qa, embed, total }. */
export async function neuronsToday(db, nowSec) {
  const day = utcDay(nowSec);
  const row = await db.prepare('SELECT summary, qa, embed FROM ai_neurons WHERE day = ?').bind(day).first();
  const summary = row?.summary ?? 0;
  const qa = row?.qa ?? 0;
  const embed = row?.embed ?? 0;
  return { day, summary, qa, embed, total: summary + qa + embed };
}
