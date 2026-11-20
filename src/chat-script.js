// The one script on the share page. It only improves the question panel; without it the forms still post as before.
//
// What it does: Enter sends the question and Shift+Enter starts a new line; the question appears at once with a loading
// animation; the answer is fetched from the page's own address and added to the panel without reloading the page.
//
// Security: the page's Content-Security-Policy allows scripts ONLY by the SHA-256 hash of this exact text (see
// CHAT_SCRIPT_HASH), so no other script can run, even if some text were ever not escaped. A test recomputes the hash:
// if you change one character below, update CHAT_SCRIPT_HASH (the test prints the new value).
// Everything the script puts on the page from a reader is set with textContent. The server's reply is parsed with DOMParser
// (which never runs scripts) and only its question-panel nodes, which the server has already escaped, are copied in.

export const CHAT_SCRIPT = `
(function () {
  var aside = document.querySelector('.chat');
  var box = document.getElementById('q');
  if (!aside || !box || !window.fetch || !window.DOMParser) return;
  var thread = aside.querySelector('.thread');
  var busy = false;

  function make(tag, cls, text) {
    var n = document.createElement(tag);
    n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function drop(sel) {
    thread.querySelectorAll(sel).forEach(function (n) { n.remove(); });
  }
  function done() {
    busy = false;
    aside.classList.remove('busy');
    aside.removeAttribute('aria-busy');
  }

  function ask(question) {
    var q = String(question || '').trim();
    if (busy || !q) return;
    busy = true;
    aside.classList.add('busy');
    aside.setAttribute('aria-busy', 'true');
    drop('.err');
    drop('.fine');
    box.value = '';

    var dots = make('div', 'loading');
    dots.setAttribute('role', 'status');
    dots.setAttribute('aria-label', 'Waiting for an answer');
    for (var i = 0; i < 3; i++) dots.appendChild(document.createElement('span'));
    thread.appendChild(make('p', 'q', q));
    thread.appendChild(dots);
    dots.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

    var failed = function (message) {
      dots.remove();
      thread.appendChild(make('p', 'err', message));
      box.value = q;
    };
    fetch(location.href, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'q=' + encodeURIComponent(q)
    })
      .then(function (res) { return res.text(); })
      .then(function (html) {
        var panel = new DOMParser().parseFromString(html, 'text/html').querySelector('.thread');
        if (!panel) return failed('Something went wrong. Please try again.');
        dots.remove();
        var hadError = false;
        Array.prototype.forEach.call(panel.children, function (n) {
          if (n.classList.contains('q')) return;
          if (n.classList.contains('err')) hadError = true;
          thread.appendChild(document.importNode(n, true));
        });
        if (hadError) box.value = q;
        thread.lastElementChild && thread.lastElementChild.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      })
      .catch(function () { failed('Could not reach the server. Please try again.'); })
      .then(done);
  }

  aside.addEventListener('submit', function (e) {
    e.preventDefault();
    var s = e.submitter;
    ask(s && s.name === 'q' ? s.value : box.value);
  });
  box.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    ask(box.value);
  });
})();
`;

// base64 SHA-256 of CHAT_SCRIPT, for the Content-Security-Policy. Checked by test/share-page.test.js.
export const CHAT_SCRIPT_HASH = 'sha256-hyi43BsliF9d79VprusygjLR2a1xTGpGfxYSE/Q/WSM=';
