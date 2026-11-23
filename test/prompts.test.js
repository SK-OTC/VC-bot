// The summary prompts were shortened. This pins every behaviour they are required to ask for, prompt by prompt, so a future trim
// cannot silently drop one. (It checks the wording is there; whether a real model obeys it needs a run on real transcripts.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { RELEVANCE, SUMMARY_EXAMPLES, glossaryLine, mapSystem, mergeNotesSystem, reduceSystem, singleSystem } from '../pipeline/prompts.mjs';
import { stripExampleNotes } from '../pipeline/summary.mjs';

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

test('the final-notes prompts (single and reduce): title, topic sections, the three fixed headings, timestamps and length', () => {
  for (const [name, p] of [['single', singleSystem({ glossary: GLOSSARY })], ['reduce', reduceSystem({ glossary: GLOSSARY })]]) {
    for (const [what, re] of COMMON) assert.match(p, re, `${name}: ${what}`);
    // the verifier (pipeline/verify.mjs) and the stored action items (splitSections) need these exact headings
    for (const h of ['**Decisions**', '**Action items**', '**Open questions**']) assert.ok(p.includes(h), `${name}: ${h}`);
    assert.match(p, /EVERY bullet, sub-bullets included, ends with the \[hh:mm:ss\] of the transcript line it came from/, `${name}: timestamps`);
    assert.match(p, /First line: a short plain title \(no bold\): the meeting's main subject, then "with" and the speakers' names/, `${name}: title`);
    assert.match(p, /2 to 6 topic sections\. Each starts with a short bold heading named after the topic/, `${name}: topic sections`);
    assert.match(p, /after a person for a status update/, `${name}: per-person progress`);
    assert.match(p, /"Outstanding items:"/, `${name}: outstanding items`);
    assert.match(p, /decisions put off \(say what they wait on\)/, `${name}: deferred decisions`);
    assert.match(p, /"None recorded"/, `${name}: empty decisions / actions`);
    assert.match(p, /one line and the whole answer under 550 words/, `${name}: length`);
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

test('the core instructions stay trimmed; the relevance rule and the examples are the only additions, and are bounded', () => {
  // sizes before the trim, with a two-term glossary: single 1476, map 1175, reduce 1619, merge 1124
  const core = (p) => p.replace(`\n\n${SUMMARY_EXAMPLES}`, '').replace(`\n${RELEVANCE}`, '');
  // the topic-section format added about 560 characters to the final prompts, and one sentence to the per-part prompt
  assert.ok(core(singleSystem({ glossary: GLOSSARY })).length < 1950);
  assert.ok(core(mapSystem({ glossary: GLOSSARY })).length < 1050);
  assert.ok(core(reduceSystem({ glossary: GLOSSARY })).length < 2050);
  assert.ok(core(mergeNotesSystem({ glossary: GLOSSARY })).length < 950);
  assert.ok(RELEVANCE.length < 450, 'the relevance rule is sent with every request');
  assert.ok(SUMMARY_EXAMPLES.length < 3600, 'the examples are sent with every final request (about 1,000 tokens)');
});

test('every prompt keeps what matters, drops small talk and jokes (unless the meeting is casual), in a formal tone', () => {
  for (const [name, p] of [['single', singleSystem()], ['map', mapSystem()], ['reduce', reduceSystem()], ['merge', mergeNotesSystem()]]) {
    assert.match(p, /Keep what matters to the meeting's purpose: topics, conclusions, decisions, commitments, numbers, risks and blockers/, name);
    assert.match(p, /Leave out greetings, small talk, jokes, banter and off-topic remarks, unless the meeting itself is casual/, name);
    assert.match(p, /formal, serious, neutral tone/, name);
  }
});

test('the final-notes prompts carry the two few-shot examples (work and casual) in the real format; the per-part ones do not', () => {
  for (const p of [singleSystem(), reduceSystem()]) {
    assert.ok(p.includes(SUMMARY_EXAMPLES));
    assert.match(p, /illustrations only: never copy their names, facts or timestamps/);
  }
  assert.ok(!mapSystem().includes('Example 1') && !mergeNotesSystem().includes('Example 1'), 'per-part prompts stay small');
  // the examples follow the real format: a plain title, bold topic headings, the three fixed headings, a timestamp on every
  // bullet and sub-bullet (except a label such as "Outstanding items:"), and what was left out
  const notes = SUMMARY_EXAMPLES.split('Notes:\n').slice(1).map((n) => n.split('\n(Left out')[0]);
  assert.equal(notes.length, 2);
  for (const n of notes) {
    const lines = n.split('\n');
    assert.match(lines[0], /^[^*\-].* with .+$/, 'a plain title line naming the speakers');
    for (const h of ['**Decisions**', '**Action items**', '**Open questions**']) assert.ok(n.includes(h), h);
    assert.ok(n.indexOf('**Decisions**') > n.search(/\n\*\*(?!Decisions)[^*]+\*\*\n/), 'topic sections come first');
    for (const line of lines.filter((l) => /^\s*- /.test(l) && !/None|^\s*- Outstanding items:$/.test(l))) assert.match(line, /\[\d\d:\d\d:\d\d\]$/, line);
  }
  assert.match(notes[0], /\*\*Maya's progress \(cart page\)\*\*\n/, 'a status update is grouped by person');
  assert.match(notes[0], /- Outstanding items:\n  - /, 'outstanding items as sub-bullets');
  assert.match(notes[0], /waits on finance/, 'a decision that waits on someone says so');
  assert.match(SUMMARY_EXAMPLES, /Left out: the climbing trip \[00:00:04\] and the remark about Omar's arms \[00:02:40\]/);
  assert.ok(!/climbing|arms/i.test(notes[0]), 'the work example\'s notes contain neither the small talk nor the joke');
  assert.match(notes[1], /Informal team catch-up/, 'a casual meeting still gets its main topics');
});

test('a "(Left out: ...)" line copied from the examples never reaches the team', () => {
  const copied = '**Summary**\n- A [00:00:01]\n(Left out: the joke [00:00:02].)\n\n**Decisions**\n- None recorded';
  assert.equal(stripExampleNotes(copied), '**Summary**\n- A [00:00:01]\n\n**Decisions**\n- None recorded');
  assert.equal(stripExampleNotes('- We left out the old logo [00:00:03]'), '- We left out the old logo [00:00:03]', 'ordinary text is untouched');
});
