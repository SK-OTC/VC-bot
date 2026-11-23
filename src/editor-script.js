// The one script on the /admin page: it makes the summary editable in place (like Granola), saves as you type, and runs the
// "Edit with AI" panel. Without it the page still works: the <noscript> text box and the restore button are plain form posts.
//
// What it does:
//  * The notes, drawn exactly as the reader page draws them, become editable. Selecting text shows a small toolbar: bold,
//    italic, underline, strikethrough, quote, subtext, bulleted list, numbered list, heading. Ctrl/Cmd+B, I and U work too;
//    Ctrl/Cmd+Shift+X is strikethrough. Tab and Shift+Tab indent a list item (up to two levels).
//  * Pasted text comes in as plain text, so formatting from other pages never enters the notes.
//  * Autosave: 1.5 seconds after the last change the page converts the notes back to their text format (src/editor-core.js,
//    included below as-is) and posts them with the version it started from. If someone else saved in between, nothing is
//    overwritten: the page asks whether to load their version or keep this one.
//  * Edit with AI: the instruction and the current notes are posted; the reply is a PROPOSAL, drawn with the changed lines
//    highlighted, and nothing is saved until the person presses Accept (Discard puts the notes back).
//
// Security: the page's Content-Security-Policy allows scripts ONLY by the SHA-256 hash of this exact text (EDITOR_SCRIPT_HASH),
// so no other script can run. A test recomputes the hash: if you change one character here or in src/editor-core.js, update
// EDITOR_SCRIPT_HASH (the test prints the new value). Text from a person or the model is set with textContent; the proposal's
// HTML comes from the server's renderNote() (which escapes everything) and is parsed with DOMParser, which never runs scripts.

// The converter is embedded as fixed source text, never via a function's .toString(): the bundler rewrites function code, which
// changed the deployed script and broke its hash (see src/editor-core.js).
import { DOM_TO_TEXT_SOURCE } from './editor-core.js';

export const EDITOR_SCRIPT = `
(function () {
  'use strict';
  var notes = document.getElementById('notes');
  if (!notes || !window.fetch || !window.DOMParser || !document.execCommand || !window.getSelection) return;
  var domToText = ${DOM_TO_TEXT_SOURCE};

  var status = document.getElementById('save-status');
  var toolbar = document.getElementById('toolbar');
  var conflictBar = document.getElementById('conflict');
  var previewBar = document.getElementById('preview');
  var version = Number(notes.getAttribute('data-version')) || 0;
  var lastSaved = domToText(notes);
  var timer = null;
  var retryTimer = null;
  var saving = false;
  var again = false;
  var paused = false;

  function make(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function setStatus(text, kind) {
    status.textContent = text;
    status.className = 'save' + (kind ? ' ' + kind : '');
  }
  function lockHashes() {
    notes.querySelectorAll('.hash').forEach(function (h) { h.setAttribute('contenteditable', 'false'); });
  }
  function editable(on) {
    notes.setAttribute('contenteditable', on ? 'true' : 'false');
  }

  editable(true);
  notes.setAttribute('spellcheck', 'true');
  notes.classList.add('editing');
  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) {}
  try { document.execCommand('styleWithCSS', false, false); } catch (e) {}
  lockHashes();
  if (!notes.textContent.trim()) notes.innerHTML = '<p><br></p>';
  setStatus('All changes saved', 'ok');

  // ---------- saving ----------

  function post(fields) {
    var body = Object.keys(fields).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(fields[k]); }).join('&');
    return fetch(location.pathname, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body
    }).then(function (res) {
      return res.json().then(
        function (j) { j.status = res.status; return j; },
        function () { return { ok: false, status: res.status }; }
      );
    });
  }
  function schedule() {
    if (paused) return;
    setStatus('Editing...');
    clearTimeout(timer);
    timer = setTimeout(save, 1500);
  }
  // A refusal will not change by sending the same thing again, so it is not retried. The server's plain-text refusals (403,
  // 413, 415) have no message of their own, so these fixed ones say what to do.
  function refusal(status) {
    if (status === 413) return 'Not saved: the summary is too long to save. Shorten it and it will save again.';
    if (status === 403) return 'Not saved: the browser blocked the save. Reload the page and try again.';
    return 'Not saved: the server refused this change. Reload the page and try again.';
  }
  function retry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(save, 5000);
  }
  function save(force) {
    clearTimeout(timer);
    if (paused) return;
    if (saving) { again = true; return; }
    var text = domToText(notes);
    if (text === lastSaved && force !== true) { setStatus('All changes saved', 'ok'); return; }
    if (!text.trim()) { setStatus('The summary cannot be empty, so this was not saved.', 'bad'); return; }
    saving = true;
    setStatus('Saving...');
    post({ autosave: '1', version: String(version), summary: text }).then(function (j) {
      saving = false;
      if (j.ok) { version = j.version; lastSaved = text; setStatus('All changes saved', 'ok'); }
      else if (j.conflict) conflict(j.version);
      else if (j.status >= 400 && j.status < 500) setStatus(j.error || refusal(j.status), 'bad');
      else { setStatus('Not saved yet. Trying again...', 'bad'); retry(); }
      if (again) { again = false; save(); }
    }, function () {
      saving = false;
      setStatus('Not saved: the server could not be reached. Trying again...', 'bad');
      retry();
    });
  }
  function conflict(latest) {
    paused = true;
    setStatus('Not saved', 'bad');
    conflictBar.hidden = false;
    conflictBar.querySelector('[data-act="reload"]').onclick = function () { lastSaved = domToText(notes); location.reload(); };
    conflictBar.querySelector('[data-act="keep"]').onclick = function () {
      version = Number(latest) || 0;
      paused = false;
      conflictBar.hidden = true;
      save(true);
    };
  }
  notes.addEventListener('input', schedule);
  var previewOpen = false;
  window.addEventListener('beforeunload', function (e) {
    if (saving || previewOpen || domToText(notes) !== lastSaved) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------- formatting ----------

  function range() {
    var s = window.getSelection();
    if (!s.rangeCount) return null;
    var r = s.getRangeAt(0);
    return notes.contains(r.commonAncestorContainer) ? r : null;
  }
  function blockOf(node) {
    while (node && node !== notes) {
      if (node.nodeType === 1 && /^(P|DIV|H[1-6]|BLOCKQUOTE|LI)$/.test(node.nodeName)) return node;
      node = node.parentNode;
    }
    return null;
  }
  function currentBlock() {
    var r = range();
    return r ? blockOf(r.startContainer) : null;
  }
  function leaveList(b) {
    if (b && b.nodeName === 'LI') document.execCommand(b.parentNode.nodeName === 'OL' ? 'insertOrderedList' : 'insertUnorderedList');
  }
  function toggleBlock(tag) {
    var b = currentBlock();
    var on = b && b.nodeName === tag;
    leaveList(b);
    document.execCommand('formatBlock', false, on ? '<p>' : '<' + tag.toLowerCase() + '>');
  }
  function toggleSub() {
    var b = currentBlock();
    leaveList(b);
    if (!b || b.nodeName !== 'P') document.execCommand('formatBlock', false, '<p>');
    b = currentBlock();
    if (b && b.nodeName === 'P') b.classList.toggle('sub');
  }
  function run(cmd) {
    if (paused) return;
    notes.focus();
    if (cmd === 'bold' || cmd === 'italic' || cmd === 'underline' || cmd === 'strikeThrough') document.execCommand(cmd);
    else if (cmd === 'ul') document.execCommand('insertUnorderedList');
    else if (cmd === 'ol') document.execCommand('insertOrderedList');
    else if (cmd === 'quote') toggleBlock('BLOCKQUOTE');
    else if (cmd === 'heading') toggleBlock('H2');
    else if (cmd === 'sub') toggleSub();
    lockHashes();
    schedule();
    refresh();
  }
  function refresh() {
    var b = currentBlock();
    var list = b && b.nodeName === 'LI' ? b.parentNode.nodeName : '';
    toolbar.querySelectorAll('button').forEach(function (btn) {
      var cmd = btn.getAttribute('data-cmd');
      var on = false;
      try {
        if (cmd === 'bold' || cmd === 'italic' || cmd === 'underline' || cmd === 'strikeThrough') on = document.queryCommandState(cmd);
      } catch (e) {}
      if (cmd === 'ul') on = list === 'UL';
      if (cmd === 'ol') on = list === 'OL';
      if (cmd === 'quote') on = !!b && b.nodeName === 'BLOCKQUOTE';
      if (cmd === 'heading') on = !!b && /^H[1-6]$/.test(b.nodeName);
      if (cmd === 'sub') on = !!b && b.nodeName === 'P' && b.classList.contains('sub');
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  function placeToolbar() {
    var r = range();
    if (!r || r.collapsed || paused) { toolbar.hidden = true; return; }
    var rect = r.getBoundingClientRect();
    toolbar.hidden = false;
    var w = toolbar.offsetWidth;
    var h = toolbar.offsetHeight;
    var left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.left + rect.width / 2 - w / 2));
    var top = rect.top - h - 8;
    if (top < 58) top = rect.bottom + 8;
    toolbar.style.left = left + 'px';
    toolbar.style.top = top + 'px';
    refresh();
  }
  document.addEventListener('selectionchange', placeToolbar);
  window.addEventListener('resize', placeToolbar);
  window.addEventListener('scroll', placeToolbar, true);
  toolbar.addEventListener('mousedown', function (e) { e.preventDefault(); });
  toolbar.addEventListener('click', function (e) {
    var btn = e.target.closest('button');
    if (btn) run(btn.getAttribute('data-cmd'));
  });

  notes.addEventListener('keydown', function (e) {
    if (paused) return;
    var mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && (e.key === 'x' || e.key === 'X')) { e.preventDefault(); run('strikeThrough'); return; }
    if (e.key === 'Tab') {
      var b = currentBlock();
      if (!b || b.nodeName !== 'LI') return;
      e.preventDefault();
      var d = b.classList.contains('d2') ? 2 : b.classList.contains('d1') ? 1 : 0;
      d = Math.max(0, Math.min(2, d + (e.shiftKey ? -1 : 1)));
      b.classList.remove('d0', 'd1', 'd2');
      b.classList.add('d' + d);
      schedule();
    }
  });
  notes.addEventListener('paste', function (e) {
    e.preventDefault();
    var t = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    if (t) document.execCommand('insertText', false, t);
  });
  notes.addEventListener('drop', function (e) { e.preventDefault(); });

  // ---------- edit with AI ----------

  var aside = document.querySelector('.chat');
  var form = document.getElementById('ai-form');
  var box = document.getElementById('ai');
  if (!aside || !form || !box) return;
  aside.hidden = false;
  var thread = aside.querySelector('.thread');
  var busy = false;

  function say(cls, text) {
    var n = make('p', cls, text);
    thread.appendChild(n);
    n.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return n;
  }
  function countText(j) {
    var parts = [];
    if (j.changed) parts.push(j.changed + (j.changed === 1 ? ' line changed or added' : ' lines changed or added'));
    if (j.removed) parts.push(j.removed + (j.removed === 1 ? ' line removed' : ' lines removed'));
    return parts.join(', ') || 'Changes proposed';
  }
  function preview(j) {
    previewOpen = true;
    paused = true;
    clearTimeout(timer);
    toolbar.hidden = true;
    var before = notes.innerHTML;
    var doc = new DOMParser().parseFromString('<div id="p">' + j.html + '</div>', 'text/html');
    var holder = doc.getElementById('p');
    notes.innerHTML = '';
    Array.prototype.forEach.call(holder.childNodes, function (n) { notes.appendChild(document.importNode(n, true)); });
    editable(false);
    notes.classList.add('previewing');
    previewBar.querySelector('.msg').textContent = countText(j) + '. Accept to keep them, or discard.';
    previewBar.hidden = false;
    var first = notes.querySelector('.chg') || previewBar;
    first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    function finish(kept) {
      previewOpen = false;
      previewBar.hidden = true;
      notes.classList.remove('previewing');
      if (kept) notes.querySelectorAll('.chg').forEach(function (n) { n.classList.remove('chg'); });
      else notes.innerHTML = before;
      lockHashes();
      editable(true);
      paused = false;
      say('fine', kept ? 'Accepted. Saving...' : 'Discarded. The notes are as they were.');
      if (domToText(notes) !== lastSaved) save();
    }
    previewBar.querySelector('[data-act="accept"]').onclick = function () { finish(true); };
    previewBar.querySelector('[data-act="discard"]').onclick = function () { finish(false); };
  }
  function ask(instruction) {
    var q = String(instruction || '').trim();
    if (busy || paused || !q) return;
    // Save what was typed in the last moments first (the timer would be cancelled by the proposal), so it is never lost.
    clearTimeout(timer);
    if (domToText(notes) !== lastSaved) save();
    busy = true;
    aside.classList.add('busy');
    editable(false);
    box.value = '';
    say('q', q);
    var dots = make('div', 'loading');
    dots.setAttribute('role', 'status');
    dots.setAttribute('aria-label', 'Waiting for the AI');
    for (var i = 0; i < 3; i++) dots.appendChild(document.createElement('span'));
    thread.appendChild(dots);
    function done() {
      busy = false;
      aside.classList.remove('busy');
      if (!paused) editable(true);
    }
    post({ ai: q, summary: domToText(notes) }).then(function (j) {
      dots.remove();
      done();
      if (!j.ok) { say('err', j.error || 'Something went wrong. Please try again.'); box.value = q; return; }
      say('fine', countText(j) + '. They are highlighted in the notes.');
      preview(j);
    }, function () {
      dots.remove();
      done();
      say('err', 'Could not reach the server. Please try again.');
      box.value = q;
    });
  }
  form.addEventListener('submit', function (e) { e.preventDefault(); ask(box.value); });
  box.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(box.value); }
  });
})();
`;

// base64 SHA-256 of EDITOR_SCRIPT, for the Content-Security-Policy. Checked by test/editor.test.js.
export const EDITOR_SCRIPT_HASH = 'sha256-LNk1pt+GTN0qMnvz94ZBwP5p28XwRM5F3bmm/Di8Wck=';
