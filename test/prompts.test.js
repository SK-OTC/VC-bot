// Pins every behaviour the summary prompts must ask for, so a future edit cannot silently drop one. Each rule here made a
// visible difference in the 2026-11-23 test on two real meetings (see pipeline/prompts.mjs). This checks the wording is there;
// whether a model obeys it needs a run on real transcripts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FINAL_FORMAT,
  NAMES,
  PURPOSE,
  SPECIFIC,
  SUMMARY_EXAMPLE,
  contextBlock,
  draftMergeSystem,
  glossaryLine,
  mapSystem,
  mergeNotesSystem,
  reduceSystem,
  singleSystem,
} from '../pipeline/prompts.mjs';
import { stripExampleNotes } from '../pipeline/summary.mjs';

const GLOSSARY = 'LiteCut, CapCut';
const CONTEXT = contextBlock({ name: 'Video team', startedAt: '2026-11-23T17:04:00Z', lengthSec: 2171, speakers: ['Lena', 'Omar Haddad'] });
const ALL = { single: singleSystem, map: mapSystem, merge: mergeNotesSystem, reduce: reduceSystem, drafts: draftMergeSystem };

test('context: date, a calendar to copy dates from, length, speakers and name; nothing when nothing is known', () => {
  assert.match(CONTEXT, /^Meeting context \(from the recording, not the conversation\):/);
  assert.match(CONTEXT, /- Meeting name: Video team/);
  assert.match(CONTEXT, /- Date: Monday 23 November 2026 \(UTC\)\./);
  assert.match(CONTEXT, /Copy the date from this list; never work one out yourself: today = Monday 23 November; tomorrow = Tuesday 24 November; Wednesday 25 November; Thursday 26 November; Friday 27 November;/);
  assert.match(CONTEXT, /- Length: 00:36:11/);
  assert.match(CONTEXT, /- Speakers \(their Discord names\): Lena, Omar Haddad/);
  assert.equal(contextBlock({}), '');
  assert.equal(contextBlock(undefined), '');
  assert.equal(contextBlock({ startedAt: 'not a date' }), '');
  assert.ok(!contextBlock({ speakers: ['A'] }).includes('Date'), 'no date line without a date');
});

test('every prompt carries the glossary spellings (correct spelling only) and the meeting context', () => {
  for (const [name, build] of Object.entries(ALL)) {
    const p = build({ glossary: 'LiteCut=Lite Cut, CapCut', context: CONTEXT });
    assert.match(p, /always spell them exactly like this\): LiteCut, CapCut\./, name);
    assert.ok(!p.includes('Lite Cut'), `${name}: the mishearing is not shown`);
    assert.ok(p.includes(CONTEXT), `${name}: context`);
    assert.match(p, /never invent owners, deadlines, numbers or names/i, `${name}: never invent`);
  }
  assert.ok(!singleSystem().includes('Meeting context ('), 'no empty context block');
});

test('the leave-out list (side chat, resumes, anything private) is in every prompt that sees the transcript or the drafts', () => {
  for (const [name, build] of Object.entries(ALL)) {
    const p = build();
    assert.match(p, /small talk, hobbies and TV, job applications, resumes and career advice, personal favours between attendees, and anything someone asked to keep private/, name);
  }
  assert.match(PURPOSE, /Leave out completely, even when they take many minutes/);
  assert.match(PURPOSE, /These notes are shared with the team/);
  assert.match(draftMergeSystem(), /Drop anything either draft included that belongs to this leave-out list/);
});

test('the final-notes prompts: specific bullets, names, the format with one "Next steps" list, and the example', () => {
  for (const [name, p] of [['single', singleSystem({ glossary: GLOSSARY })], ['reduce', reduceSystem({ glossary: GLOSSARY })], ['drafts', draftMergeSystem({ glossary: GLOSSARY })]]) {
    assert.ok(p.includes(SPECIFIC), `${name}: be specific`);
    assert.ok(p.includes(FINAL_FORMAT), `${name}: format`);
  }
  for (const p of [singleSystem(), reduceSystem()]) {
    assert.ok(p.includes(NAMES));
    assert.ok(p.includes(SUMMARY_EXAMPLE));
  }
  assert.match(SPECIFIC, /A bullet that only names a topic \("Output format discussed"\) is not allowed/);
  assert.match(NAMES, /including people who are only mentioned/);
  assert.match(NAMES, /"Short name \(Discord name\)"/);
  assert.match(FINAL_FORMAT, /First line: a short plain title \(no bold\)/);
  assert.match(FINAL_FORMAT, /2 to 5 topic sections; never repeat a point in two sections\. Topic bullets have NO timestamps\./);
  assert.match(FINAL_FORMAT, /\*\*Next steps\*\*\n- Owner: task, with the detail and due date needed to act on it \[hh:mm:ss\]/);
  assert.match(FINAL_FORMAT, /ONE timestamp in the form \[hh:mm:ss\] \(for example \[00:34:18\]; never a range, never \[mm:ss\]\)/);
  assert.match(FINAL_FORMAT, /never turn a topic into a task nobody took on\. At most 10 next steps/);
  assert.match(FINAL_FORMAT, /"Unassigned"/);
  assert.match(FINAL_FORMAT, /Add a due date only if one was said/);
  assert.match(FINAL_FORMAT, /"None recorded"/);
  assert.match(FINAL_FORMAT, /No other sections\. Keep the whole answer under 450 words\./);
  assert.ok(!/\*\*(Decisions|Open questions|Action items)\*\*/.test(FINAL_FORMAT), 'the old fixed sections are gone');
});

test('the per-part prompts ask for detailed notes and a NEXT STEPS list; they stay small (no example)', () => {
  const map = mapSystem({ glossary: GLOSSARY });
  assert.match(map, /ONE PART of a longer meeting transcript/);
  assert.match(map, /anything you leave out is lost/);
  assert.match(map, /Write DETAILED notes/);
  assert.match(map, /no tables/);
  assert.match(map, /ONE \[hh:mm:ss\] \(never a range\)/);
  assert.match(map, /NEXT STEPS: "Owner: task \(due date if said\) \[hh:mm:ss\]"/);
  assert.match(map, /Use only this part/);
  assert.match(mergeNotesSystem(), /Do not drop any next step: keep its owner, due date and \[hh:mm:ss\] timestamp/);
  assert.match(reduceSystem(), /keep every specific detail and every next step with its \[hh:mm:ss\]/);
  for (const p of [mapSystem(), mergeNotesSystem(), draftMergeSystem()]) assert.ok(!p.includes(SUMMARY_EXAMPLE));
  assert.ok(mapSystem({ glossary: GLOSSARY }).length < 2100);
  assert.ok(mergeNotesSystem({ glossary: GLOSSARY }).length < 1400);
});

test('the draft merge keeps what either draft caught, adds nothing, and resolves disagreements conservatively', () => {
  const p = draftMergeSystem();
  assert.match(p, /two drafts of notes for the SAME meeting, written independently/);
  assert.match(p, /keep every specific point about the work that appears in EITHER draft/);
  assert.match(p, /never add anything that is in neither draft/);
  assert.match(p, /keep the version that is more specific; if you cannot tell, leave that detail out/);
});

test('the example: invented names, the real format, no timestamps on topic bullets, and the side chat left out', () => {
  const notes = SUMMARY_EXAMPLE.split('Notes:\n')[1].split('\n(Left out')[0];
  const lines = notes.split('\n');
  assert.match(lines[0], /^[^*\-]/, 'a plain title line');
  assert.ok(notes.includes('**Next steps**'));
  const [topics, steps] = notes.split('**Next steps**');
  for (const l of topics.split('\n').filter((x) => /^\s*- /.test(x))) assert.ok(!/\[\d\d:\d\d:\d\d\]/.test(l), l);
  for (const l of steps.split('\n').filter((x) => /^\s*- /.test(x))) assert.match(l, /\[\d\d:\d\d:\d\d\]$/, l);
  assert.match(notes, /Pending: a browser preview, which Raj wants; waits on Lena's talk with Raj/, 'a decision that waits on someone');
  assert.match(notes, /\*\*Oz \(Omar Haddad\): speed per segment\*\*/, 'a nickname matched to its speaker');
  assert.match(notes, /before Thursday 10 March/, 'a weekday turned into a date');
  assert.ok(!/football|last night|three nil/i.test(notes), 'the side chat is not in the notes');
  assert.match(SUMMARY_EXAMPLE, /\(Left out: the football chat \[00:04:40\]\.\)/);
  assert.match(SUMMARY_EXAMPLE, /illustration only: never copy its names, facts or dates/);
});

test('the glossary line: only the correct spelling of each entry, up to 60; empty without a glossary', () => {
  assert.match(glossaryLine('LiteCut=Lite Cut|Lite cut, CapCut'), /LiteCut, CapCut\./);
  assert.ok(!glossaryLine('LiteCut=Lite Cut').includes('Lite Cut'));
  assert.equal(glossaryLine(''), '');
  assert.equal(glossaryLine(undefined), '');
});

test('a "(Left out: ...)" line copied from the example never reaches the team', () => {
  const copied = 'Title\n\n**Topic**\n- A\n(Left out: the joke [00:00:02].)\n\n**Next steps**\n- None recorded';
  assert.equal(stripExampleNotes(copied), 'Title\n\n**Topic**\n- A\n\n**Next steps**\n- None recorded');
  assert.equal(stripExampleNotes('- We left out the old logo [00:00:03]'), '- We left out the old logo [00:00:03]', 'ordinary text is untouched');
});

test('the word limit covers the whole notes and grows with the meeting: 450 up to 45 minutes, +150 per half hour, at most 900', async () => {
  const { wordLimit, finalFormat } = await import('../pipeline/prompts.mjs');
  const min = (m) => wordLimit(m * 60);
  assert.deepEqual([min(10), min(36), min(45), min(46), min(75), min(76), min(105), min(120), min(240)], [450, 450, 450, 600, 600, 750, 750, 900, 900]);
  assert.equal(wordLimit(undefined), 450);
  assert.equal(wordLimit('x'), 450);
  assert.match(finalFormat(750), /Keep the whole answer under 750 words\./);
  for (const build of [singleSystem, reduceSystem, draftMergeSystem]) {
    assert.match(build({ words: 600 }), /under 600 words/);
    assert.match(build(), /under 450 words/);
  }
});
