// The summary prompts were shortened. This pins every behaviour they are required to ask for, prompt by prompt, so a future trim
// cannot silently drop one. (It checks the wording is there; whether a real model obeys it needs a run on real transcripts.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { glossaryLine, mapSystem, mergeNotesSystem, reduceSystem, singleSystem } from '../pipeline/prompts.mjs';

const GLOSSARY = 'LiteCut, CapCut';

// [behaviour, pattern] pairs every prompt that writes or rewrites notes must keep
const COMMON = [
  ['only the transcript', /Use ONLY the transcript/],
  ['never invent owners, deadlines, numbers or names', /Never invent owners, deadlines, numbers or names/],
  ['spell speakers\' names as in the transcript', /spell speakers' names as in the transcript/],
  ['the transcript may be wrong: leave out the unclear', /may be wrong: leave out anything unclear/],
  ['include every clearly stated decision and action item, even small ones', /every clearly stated decision and action item, even small ones/],
  ['action item format Owner: task [hh:mm:ss]', /Owner: task \[hh:mm:ss\]/],
  ['the owner is a name exactly as in the transcript, or Unassigned', /speaker's name exactly as it appears in the transcript, or "Unassigned"/],
  ['a due date only if said', /due date only if one was actually said/],
  ['the glossary spellings', /LiteCut, CapCut/],
];

test('the final-notes prompts (single and reduce) keep the four headings, the timestamp rule and the length rules', () => {
  for (const [name, p] of [['single', singleSystem({ glossary: GLOSSARY })], ['reduce', reduceSystem({ glossary: GLOSSARY })]]) {
    for (const [what, re] of COMMON) assert.match(p, re, `${name}: ${what}`);
    for (const h of ['**Summary**', '**Decisions**', '**Action items**', '**Open questions**']) assert.ok(p.includes(h), `${name}: ${h}`);
    assert.match(p, /EVERY bullet ends with the \[hh:mm:ss\] of the transcript line it came from/, `${name}: timestamps`);
    assert.match(p, /4 to 8 short bullets/, `${name}: summary size`);
    assert.match(p, /"None recorded"/, `${name}: empty decisions / actions`);
    assert.match(p, /one line and the whole answer under 450 words/, `${name}: length`);
  }
  assert.match(singleSystem(), /You write meeting notes from an automatic transcript\./);
  assert.match(singleSystem(), /Each transcript line looks like "\[hh:mm:ss\] Name: what they said"\./);
});

test('the reduce prompt keeps every action item from the chunk notes', () => {
  assert.match(reduceSystem(), /Do not drop any action item from the chunk notes: each must appear in the result with its \[hh:mm:ss\] timestamp/);
  assert.match(reduceSystem(), /Combine them into the final meeting notes and merge duplicates/);
});

test('the per-part prompt keeps the four lists in order, the timestamp rule, and "use only this part"', () => {
  const p = mapSystem({ glossary: GLOSSARY });
  for (const [what, re] of COMMON) assert.match(p, re, `map: ${what}`);
  assert.match(p, /ONE PART of a longer meeting transcript/);
  assert.match(p, /TOPICS, DECISIONS, ACTION ITEMS, OPEN QUESTIONS/);
  assert.match(p, /"none" under an empty list/);
  assert.match(p, /Every item ends with the \[hh:mm:ss\] of the transcript line it came from/);
  assert.match(p, /Use only this part/);
});

test('the merge prompt keeps the four lists, never drops an action item, and keeps every timestamp', () => {
  const p = mergeNotesSystem({ glossary: GLOSSARY });
  for (const [what, re] of COMMON) assert.match(p, re, `merge: ${what}`);
  assert.match(p, /TOPICS, DECISIONS, ACTION ITEMS, OPEN QUESTIONS/);
  assert.match(p, /Do not drop any action item: keep its owner, due date and timestamp/);
  assert.match(p, /Every item keeps its \[hh:mm:ss\] timestamp/);
  assert.match(p, /shorter set of notes/);
});

test('the glossary line is unchanged: only the correct spelling of each entry, up to 60', () => {
  assert.match(glossaryLine('LiteCut=Lite Cut|Lite cut, CapCut'), /LiteCut, CapCut\./);
  assert.ok(!glossaryLine('LiteCut=Lite Cut').includes('Lite Cut'));
});

test('they got shorter', () => {
  // sizes before the trim, with a two-term glossary: single 1476, map 1175, reduce 1619, merge 1124
  assert.ok(singleSystem({ glossary: GLOSSARY }).length < 1300);
  assert.ok(mapSystem({ glossary: GLOSSARY }).length < 1000);
  assert.ok(reduceSystem({ glossary: GLOSSARY }).length < 1400);
  assert.ok(mergeNotesSystem({ glossary: GLOSSARY }).length < 950);
});
