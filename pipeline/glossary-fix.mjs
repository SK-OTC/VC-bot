// Glossary post-correction: fixes names and terms the speech model misspelled. Always on, for every engine.
//
// A glossary is entries separated by commas, semicolons or new lines. An entry is the correct spelling, optionally followed
// by known mishearings:   LiteCut=Lite Cut|Lite cut, CapCut, Zoe
//
//  1. LISTED mishearings ("Lite Cut" for LiteCut) are always replaced: whole words or phrases, case-insensitive.
//  2. FUZZY: a single-word term of 5+ letters also corrects words within edit distance 1 (2 for terms of 9+ letters).
//     Whole words only. A word that is an ordinary English word is NEVER changed by fuzzy matching: only a listed
//     mishearing may change it. (The check uses pipeline/english-words.txt, see english-words.LICENSE.txt.)
//  3. CASE: the same word with the wrong capitalisation ("litecut") is put right, unless the term is itself an ordinary word
//     (Notion, Slack, Teams): those are left alone, because "notion" the idea would be wrongly changed.
// The original capitalisation pattern is kept: ALL CAPS stays upper case, Title Case stays Title Case, lower case stays lower
// case. A term with its own mixed capitals (LiteCut, iPhone) is written exactly as in the glossary, because that IS its spelling.
//
// Every replacement is returned as { from, to, t, kind } so the caller can keep it in the uploaded record. This module never
// logs and never decides what is shown: the posted transcript shows no marks, and the public job log shows only a count.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_ENTRIES = 200;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’]*/gu;
const POSSESSIVE = /['’]s$/i;

let cached = null;
/** The set of ordinary English words (lower case). Loaded once. */
export function loadCommonWords(file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'english-words.txt')) {
  if (file === undefined || cached?.file !== file) {
    cached = { file, words: new Set(readFileSync(file, 'utf8').split('\n').filter(Boolean)) };
  }
  return cached.words;
}

/** "LiteCut=Lite Cut|Lite cut, CapCut" -> [{ term, mishearings }]. Blank entries are ignored. */
export function parseGlossary(text) {
  const entries = [];
  const seen = new Set();
  for (const raw of String(text ?? '').split(/[,;\n]/)) {
    const [left, right = ''] = raw.split('=');
    const term = left.trim().replace(/\s+/g, ' ');
    if (!term || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    const mishearings = right
      .split('|')
      .map((m) => m.trim().replace(/\s+/g, ' '))
      .filter((m) => m && m.toLowerCase() !== term.toLowerCase());
    entries.push({ term, mishearings });
    if (entries.length >= MAX_ENTRIES) break;
  }
  return entries;
}

/** Edit distance (insert, delete, substitute) between a and b, or max + 1 when it is more than max. */
export function levenshtein(a, b, max = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length] <= max ? prev[b.length] : max + 1;
}

const hasOwnCapitals = (term) => term !== term.toLowerCase() && term !== term[0].toUpperCase() + term.slice(1).toLowerCase();

/** The term, written the way the source text was capitalised. */
export function applyCase(source, term) {
  const allCaps = source.length > 1 && source === source.toUpperCase() && source !== source.toLowerCase();
  if (allCaps) return term.toUpperCase();
  if (hasOwnCapitals(term)) return term; // LiteCut, iPhone: the glossary spelling is the spelling
  if (source === source.toLowerCase()) return term.toLowerCase();
  if (source[0] === source[0].toUpperCase()) return term[0].toUpperCase() + term.slice(1).toLowerCase();
  return term;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** maxDistance for a term: 0 below 5 letters (exact only), 1 from 5 letters, 2 from 9 letters. */
export const maxDistanceFor = (term) => (term.length >= 9 ? 2 : term.length >= 5 ? 1 : 0);

/**
 * glossary: the text described at the top. commonWords: a Set of ordinary words (default: loaded from disk).
 * Returns { enabled, entries, fix(text, { t }) -> { text, changes } }.
 */
export function createGlossaryFixer(glossary, { commonWords = null } = {}) {
  const entries = parseGlossary(glossary);
  if (!entries.length) return { enabled: false, entries, fix: (text) => ({ text, changes: [] }) };
  const common = commonWords ?? loadCommonWords();

  // listed mishearings, longest first so "Lite Cut Pro" is tried before "Lite Cut"
  const listed = entries
    .flatMap((e) => e.mishearings.map((m) => ({ term: e.term, phrase: m })))
    .sort((a, b) => b.phrase.length - a.phrase.length)
    .map((x) => ({ ...x, re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(x.phrase).replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}])`, 'giu') }));

  // single-word terms for fuzzy and case fixes
  const words = entries.filter((e) => !/\s/.test(e.term)).map((e) => ({ term: e.term, lower: e.term.toLowerCase(), max: maxDistanceFor(e.term), isCommon: common.has(e.term.toLowerCase()) }));

  function fix(text, { t = 0 } = {}) {
    const changes = [];
    let out = String(text ?? '');

    for (const x of listed) {
      out = out.replace(x.re, (match) => {
        const to = applyCase(match, x.term);
        if (to === match) return match;
        changes.push({ from: match, to, t, kind: 'listed' });
        return to;
      });
    }

    const edits = [];
    for (const m of out.matchAll(WORD)) {
      const raw = m[0];
      const possessive = POSSESSIVE.exec(raw);
      const core = possessive ? raw.slice(0, -possessive[0].length) : raw;
      const lower = core.toLowerCase();
      if (lower.length < 2 || /^\p{N}+$/u.test(lower) || common.has(lower)) continue; // numbers and ordinary words are never touched
      let best = null;
      let tie = false;
      for (const w of words) {
        const d = lower === w.lower ? 0 : w.max > 0 ? levenshtein(lower, w.lower, w.max) : w.max + 1;
        if (d > w.max) continue;
        if (d === 0 && w.isCommon) continue; // a term that is an ordinary word is not case-fixed
        if (!best || d < best.d) {
          best = { w, d };
          tie = false;
        } else if (d === best.d && w.term !== best.w.term) tie = true;
      }
      if (!best || tie) continue; // nothing close, or two terms are equally close: leave the word alone
      const to = applyCase(core, best.w.term);
      if (to === core) continue;
      edits.push({ index: m.index, length: core.length, from: core, to, kind: best.d === 0 ? 'case' : 'fuzzy' });
    }
    for (const e of edits.sort((a, b) => b.index - a.index)) out = out.slice(0, e.index) + e.to + out.slice(e.index + e.length);
    for (const e of edits.reverse()) changes.push({ from: e.from, to: e.to, t, kind: e.kind });
    return { text: out, changes };
  }

  return { enabled: true, entries, fix };
}
