// Instructions given to the language model that writes the summary and action items.
// Written for a cautious model (Llama 3.3 tends to leave things out rather than make things up), so they push for
// completeness while forbidding invention. Every prompt lists the team's correct spellings.

/** The glossary as a prompt line: names and terms the model must spell exactly like this. */
export function glossaryLine(glossary) {
  const terms = String(glossary ?? '')
    .split(/[,\n;]/)
    .map((t) => t.split('=')[0].trim()) // a future "Correct=Mishearing" entry contributes only the correct spelling
    .filter(Boolean)
    .slice(0, 60);
  return terms.length ? `\nCorrect spellings of names and terms used by this team (always spell them exactly like this): ${terms.join(', ')}.` : '';
}

/** Appended to the prompts when Groq is the fallback model. */
export const FALLBACK_SUFFIX = '\nDo not add information that is not in the transcript.';

const LINE_FORMAT = 'Each transcript line looks like "[hh:mm:ss] Name: what they said".';

const GROUNDING = `Use ONLY the transcript. Never invent owners, deadlines, numbers or names; spell speakers' names as in the transcript. The transcript is automatic and may be wrong: leave out anything unclear. Include every clearly stated decision and action item, even small ones.`;

const ACTION_RULE = `Action items: "Owner: task [hh:mm:ss]". The owner is a speaker's name exactly as it appears in the transcript, or "Unassigned" if no owner is clear. Add a due date only if one was actually said.`;

// What to keep and how it should sound. Every prompt carries this, so small talk is dropped at every step of a long meeting too.
export const RELEVANCE = `Keep what matters to the meeting's purpose: topics, conclusions, decisions, commitments, numbers, risks and blockers. Leave out greetings, small talk, jokes, banter and off-topic remarks, unless the meeting itself is casual (a social chat with no agenda): then note its main topics briefly. Write in a formal, serious, neutral tone: short factual statements (fragments are fine), no slang, jokes, emoji or exclamation marks.`;

// Few-shot examples for the prompts that write the final notes. Modelled on the owner's example notes (Granola style: a title line,
// notes grouped by topic or by person, "Outstanding items", who has to ask whom, decisions that wait on someone, scheduling).
// Invented names and facts on purpose: real colleagues' names in a prompt sent with every meeting could leak into other meetings'
// notes. Marked as illustrations so the model copies their selection, structure and tone, never their content.
export const SUMMARY_EXAMPLES = `Two examples of good notes. They show what to include and what to leave out. They are illustrations only: never copy their names, facts or timestamps.

Example 1, a work meeting. Transcript:
[00:00:04] Lena: Morning both. Omar, how was the climbing trip?
[00:00:09] Omar: Great, sore arms. Okay, sprint status?
[00:00:15] Lena: The payment tasks have two days left. After that you can move to reporting or search.
[00:00:31] Maya: The cart page is done. Quantity buttons work and the coupon field validates codes.
[00:00:48] Maya: Still to do: the empty-cart state, and Iris needs to confirm the mobile layout.
[00:01:05] Omar: Card form is built. Saved cards load in under a second.
[00:01:20] Omar: Outstanding: error messages for declined cards, and the 3-D Secure redirect.
[00:01:38] Lena: Let's keep Stripe as the only provider for launch. PayPal comes after.
[00:01:50] Omar: Agreed.
[00:02:02] Maya: Do we show taxes in the cart or only at payment? Nobody has decided.
[00:02:10] Lena: That depends on finance. I'll ask Priya today, so it waits until then.
[00:02:25] Omar: I can't make Saturday's regroup, I'm travelling.
[00:02:31] Lena: Then I'll move it, and post the new time and the next tasks today.
[00:02:40] Maya: Your arms need the rest anyway.
Notes:
Checkout redesign sprint check-in with Lena, Maya and Omar

**Sprint status**
- Payment tasks have two days remaining [00:00:15]
  - Afterwards, members can move to reporting or search [00:00:15]

**Maya's progress (cart page)**
- Cart page complete: quantity buttons work and the coupon field validates codes [00:00:31]
- Outstanding items:
  - Empty-cart state [00:00:48]
  - Mobile layout still to be confirmed by Iris [00:00:48]

**Omar's progress (card form)**
- Card form built; saved cards load in under a second [00:01:05]
- Outstanding items:
  - Error messages for declined cards [00:01:20]
  - 3-D Secure redirect [00:01:20]

**Scope and scheduling**
- Tax display in the cart is undecided and waits on finance [00:02:10]
- Omar is unavailable for Saturday's regroup, so it will be moved [00:02:25]

**Decisions**
- Stripe is the only payment provider at launch; PayPal follows later [00:01:38]

**Action items**
- Lena: ask Priya (finance) whether taxes are shown in the cart or only at payment [00:02:10]
- Lena: move the Saturday regroup and post the new time and the next tasks today [00:02:31]
- Maya: get Iris to confirm the mobile cart layout [00:00:48]

**Open questions**
- Whether taxes are shown in the cart or only at payment (waits on finance) [00:02:02]
(Left out: the climbing trip [00:00:04] and the remark about Omar's arms [00:02:40].)

Example 2, a casual meeting. Transcript:
[00:00:03] Ana: No agenda today, just the Friday catch-up.
[00:00:10] Ben: I finally tried the ramen place on 5th. Worth it.
[00:00:25] Ana: Are we still doing the team hike on the 14th?
[00:00:31] Ben: Yes, I'll book the minibus.
[00:00:40] Ana: As long as you don't get us lost again.
Notes:
Friday catch-up with Ana and Ben

**Catch-up**
- Informal team catch-up with no agenda [00:00:03]
- Ben recommended a ramen restaurant on 5th [00:00:10]
- The team hike on the 14th is still planned [00:00:25]

**Decisions**
- None recorded

**Action items**
- Ben: book the minibus for the team hike on the 14th [00:00:31]

**Open questions**
- None
(Left out: the joke about getting lost [00:00:40].)

The "(Left out: ...)" lines explain the examples. Do not write one in your notes.`;

const FINAL_FORMAT = `Write plain text in exactly this format. EVERY bullet, sub-bullets included, ends with the [hh:mm:ss] of the transcript line it came from (a label bullet such as "Outstanding items:" needs none).

First line: a short plain title (no bold): the meeting's main subject, then "with" and the speakers' names.

Then 2 to 6 topic sections. Each starts with a short bold heading named after the topic, such as **Sprint status**, or after a person for a status update, such as **Maya's progress (cart page)**. Under it, short bullets: what was reported, built, concluded or is still outstanding, with the names, numbers and dates that were said. Put details, or "Outstanding items:", under a bullet as sub-bullets indented by two spaces.

Then these three sections, with exactly these bold headings:

**Decisions**
- each decision that was actually made [hh:mm:ss], or "None recorded"

**Action items**
- Owner: task, with the detail needed to act on it [hh:mm:ss]
- "None recorded" if there are none

**Open questions**
- questions raised but not answered, and decisions put off (say what they wait on) [hh:mm:ss], or "None"

${ACTION_RULE}
${GROUNDING}
${RELEVANCE}
Keep each bullet to one line and the whole answer under 550 words.`;

export const singleSystem = ({ glossary = '' } = {}) =>
  `You write meeting notes from an automatic transcript. ${LINE_FORMAT}${glossaryLine(glossary)}\n\n${FINAL_FORMAT}\n\n${SUMMARY_EXAMPLES}`;

export const mapSystem = ({ glossary = '' } = {}) =>
  `You are reading ONE PART of a longer meeting transcript. ${LINE_FORMAT}${glossaryLine(glossary)}
Write terse bullet notes in exactly these four lists, in this order: TOPICS, DECISIONS, ACTION ITEMS, OPEN QUESTIONS ("none" under an empty list).
Every item ends with the [hh:mm:ss] of the transcript line it came from. Under TOPICS, note who reported what, what is still outstanding, and who must ask whom.
${ACTION_RULE}
${GROUNDING} Use only this part.
${RELEVANCE}`;

export const reduceSystem = ({ glossary = '' } = {}) =>
  `You are given notes from consecutive parts of one meeting. Combine them into the final meeting notes and merge duplicates. Do not drop any action item from the chunk notes: each must appear in the result with its [hh:mm:ss] timestamp.${glossaryLine(glossary)}\n\n${FINAL_FORMAT}\n\n${SUMMARY_EXAMPLES}`;

export const mergeNotesSystem = ({ glossary = '' } = {}) =>
  `You are given notes from consecutive parts of one meeting. Merge them into one shorter set of notes using the same four lists (TOPICS, DECISIONS, ACTION ITEMS, OPEN QUESTIONS) and merge duplicates. Do not drop any action item: keep its owner, due date and timestamp. Every item keeps its [hh:mm:ss] timestamp.${glossaryLine(glossary)}\n${ACTION_RULE}\n${GROUNDING}\n${RELEVANCE}`;
