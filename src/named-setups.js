// Named recording setups (/recording setup): where a recording's transcript, summary and "recording ready" link go, chosen per
// meeting (or per preset). Every query uses bound parameters. See migrations/0016_named_recording_setups.sql for the columns.
//
// The fallback rule, in one place (resolveNamedSetup):
//   nothing chosen, blank, or "Default"   -> the Default setup (the server's "Default" row, or the built-in one if it has none)
//   a name that exists                    -> that setup
//   a name that no longer exists          -> the Default setup, with `fallback` set so the caller can SAY so (never silent)
import { nameKey, normalizeName } from './store.js';

export const DEFAULT_SETUP_NAME = 'Default';
export const DEFAULT_SETUP_KEY = 'default';
export const MAX_NAMED_SETUPS = 25;
export const MAX_SETUP_NAME = 50;

/** The built-in Default: every channel blank, so results go where they went before named setups existed. */
export const BUILTIN_DEFAULT = Object.freeze({
  id: null,
  name: DEFAULT_SETUP_NAME,
  name_key: DEFAULT_SETUP_KEY,
  private_channel_id: null,
  summary_channel_id: null,
  link_channel_id: null,
  audio: 0,
  builtin: true,
});

/** True for "no setup chosen": undefined, null, blank, or the word "default" in any case. */
export const isDefaultChoice = (name) => {
  const k = nameKey(name ?? '');
  return k === '' || k === DEFAULT_SETUP_KEY;
};

export async function getNamedSetup(db, guildId, name) {
  return (await db.prepare('SELECT * FROM named_recording_setups WHERE guild_id = ? AND name_key = ?').bind(guildId, nameKey(name ?? '')).first()) ?? null;
}

export async function listNamedSetups(db, guildId) {
  return (await db.prepare('SELECT * FROM named_recording_setups WHERE guild_id = ? ORDER BY name_key = ? DESC, name_key').bind(guildId, DEFAULT_SETUP_KEY).all()).results;
}

export async function countNamedSetups(db, guildId) {
  return (await db.prepare('SELECT COUNT(*) AS n FROM named_recording_setups WHERE guild_id = ?').bind(guildId).first())?.n ?? 0;
}

/** Names for autocomplete: "Default" first (it always exists, built in or saved), then the server's others. */
export async function searchNamedSetupNames(db, guildId, query, limit = 25) {
  const key = nameKey(query ?? '');
  const { results } = await db
    .prepare(`SELECT name FROM named_recording_setups WHERE guild_id = ? AND name_key != ? AND (? = '' OR instr(name_key, ?) > 0) ORDER BY name_key LIMIT ?`)
    .bind(guildId, DEFAULT_SETUP_KEY, key, key, limit)
    .all();
  const names = results.map((r) => r.name);
  return (key === '' || DEFAULT_SETUP_KEY.includes(key) ? [DEFAULT_SETUP_NAME, ...names] : names).slice(0, limit);
}

/** Insert or fully replace (callers merge with the existing row first). Returns { updated }. */
export async function saveNamedSetup(db, s, nowSec) {
  const existing = await getNamedSetup(db, s.guildId, s.name);
  await db
    .prepare(
      `INSERT INTO named_recording_setups (guild_id, name, name_key, private_channel_id, summary_channel_id, link_channel_id, audio, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, name_key) DO UPDATE SET name = excluded.name, private_channel_id = excluded.private_channel_id,
         summary_channel_id = excluded.summary_channel_id, link_channel_id = excluded.link_channel_id, audio = excluded.audio,
         updated_at = excluded.updated_at`,
    )
    .bind(
      s.guildId,
      normalizeName(s.name),
      nameKey(s.name),
      s.privateChannelId ?? null,
      s.summaryChannelId ?? null,
      s.linkChannelId ?? null,
      s.audio ? 1 : 0,
      String(s.createdBy),
      existing?.created_at ?? nowSec,
      nowSec,
    )
    .run();
  return { updated: Boolean(existing) };
}

export async function deleteNamedSetup(db, guildId, name) {
  const r = await db.prepare('DELETE FROM named_recording_setups WHERE guild_id = ? AND name_key = ?').bind(guildId, nameKey(name ?? '')).run();
  return (r.meta?.changes ?? 0) > 0;
}

/** How many active meetings and presets in the server name this setup (so deleting it can say what falls back to Default). */
export async function countSetupUsers(db, guildId, name) {
  const key = nameKey(name ?? '');
  const meetings = (await db.prepare("SELECT COUNT(*) AS n FROM meetings WHERE guild_id = ? AND status = 'active' AND lower(recording_setup) = ?").bind(guildId, key).first())?.n ?? 0;
  const presets = (await db.prepare('SELECT COUNT(*) AS n FROM presets WHERE guild_id = ? AND lower(recording_setup) = ?').bind(guildId, key).first())?.n ?? 0;
  return { meetings, presets };
}

/** The server's Default setup: its saved "Default" row, or the built-in one. */
export async function getDefaultSetup(db, guildId) {
  return (await getNamedSetup(db, guildId, DEFAULT_SETUP_NAME)) ?? BUILTIN_DEFAULT;
}

/**
 * A named setup with its blank channels filled in from the Default setup. A setup that names only a summary channel therefore
 * keeps the Default's private channel for the transcript: a blank field never sends private content somewhere less private than
 * the Default would. `audio` is the setup's own choice (it is not inherited).
 */
export function withDefaults(setup, def) {
  if (!setup || setup.name_key === DEFAULT_SETUP_KEY) return setup;
  return {
    ...setup,
    private_channel_id: setup.private_channel_id ?? def?.private_channel_id ?? null,
    summary_channel_id: setup.summary_channel_id ?? def?.summary_channel_id ?? null,
    link_channel_id: setup.link_channel_id ?? def?.link_channel_id ?? null,
  };
}

/**
 * The setup a recording uses, with blanks filled from the Default. `requested` is what the meeting (or preset) stored, or what was
 * typed. Returns { setup, fallback } where `fallback` is null, or { requested } when a named setup was asked for and does not exist.
 */
export async function resolveNamedSetup(db, guildId, requested) {
  const def = await getDefaultSetup(db, guildId);
  const wantsDefault = isDefaultChoice(requested);
  const found = wantsDefault ? null : await getNamedSetup(db, guildId, requested);
  if (found) return { setup: withDefaults(found, def), fallback: null };
  return { setup: def, fallback: wantsDefault ? null : { requested: normalizeName(requested) } };
}

/** The columns a recording session keeps from its setup (see createSession). */
export function sessionRouting(setup) {
  return {
    setupName: setup?.name ?? DEFAULT_SETUP_NAME,
    privateChannelId: setup?.private_channel_id ?? null,
    summaryChannelId: setup?.summary_channel_id ?? null,
    linkChannelId: setup?.link_channel_id ?? null,
    // Audio only ever goes to a channel the admin named as private for this setup (never to a fallback channel).
    audioChannelId: setup?.audio && setup?.private_channel_id ? setup.private_channel_id : null,
  };
}
