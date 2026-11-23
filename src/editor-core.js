// The /admin editor's converter: the edited page (the browser's DOM) back into the notes' text format, which is what is stored
// and what the reader page, Q&A and the restore button work with.
//
// It is kept as SOURCE TEXT, not as a function. src/editor-script.js puts this exact text into the page's script, whose
// SHA-256 hash the Content-Security-Policy allows. (Using a function's .toString() instead broke on 2026-11-23: Wrangler's
// bundler rewrites function code, with other quotes and added __name() calls, so the deployed script no longer matched its
// hash and the browser blocked it. Text inside a string is never rewritten.) The tests turn this text into a function and
// run it on a small fake DOM, so the page and the tests still run the same code.
//
// The text format (the same one renderNote() in src/share-page.js reads):
//   **Heading**                  a line that is only one bold phrase
//   - point / 1. step            list items; 2 spaces of indent = level 1, 6 spaces = level 2
//   > quote                      a quote
//   -# small print               subtext
//   anything else                a paragraph
//   inline: **bold** *italic* __underline__ ~~strikethrough~~ (Discord's marks)
//
// Written in plain ES5 style on purpose: it runs as-is in the page, with no build step.

export const DOM_TO_TEXT_SOURCE = String.raw`function domToText(root) {
  var INDENT = ['', '  ', '      '];
  var lines = [];

  function tagOf(node) {
    return node && node.nodeType === 1 ? String(node.nodeName).toUpperCase() : '';
  }
  function hasClass(node, name) {
    var c = node && node.getAttribute ? node.getAttribute('class') || '' : '';
    return (' ' + c + ' ').indexOf(' ' + name + ' ') >= 0;
  }
  function styleOf(node) {
    return node && node.getAttribute ? String(node.getAttribute('style') || '').toLowerCase() : '';
  }
  function kids(node) {
    return Array.prototype.slice.call(node.childNodes || []);
  }

  // The text of an inline run with its marks. "on" holds the marks already applied by an outer element, so nested or
  // repeated tags (<b><b>x</b></b>) never produce doubled marks.
  function inlineOf(node, on) {
    if (node.nodeType === 3) return String(node.nodeValue || '').replace(/ /g, ' ');
    if (node.nodeType !== 1) return '';
    var tag = tagOf(node);
    if (tag === 'BR') return '\n';
    if (tag === 'UL' || tag === 'OL') return ''; // nested lists are handled as their own lines
    if (hasClass(node, 'hash')) return ''; // the "#" shown before a heading is decoration, not text
    var style = styleOf(node);
    var want = {
      b: tag === 'B' || tag === 'STRONG' || /font-weight:\s*(bold|[6-9]00)/.test(style),
      i: tag === 'I' || tag === 'EM' || /font-style:\s*italic/.test(style),
      u: tag === 'U' || /text-decoration[^;]*underline/.test(style),
      s: tag === 'S' || tag === 'STRIKE' || tag === 'DEL' || /text-decoration[^;]*line-through/.test(style),
    };
    var next = { b: on.b || want.b, i: on.i || want.i, u: on.u || want.u, s: on.s || want.s };
    var inner = '';
    kids(node).forEach(function (k) {
      inner += inlineOf(k, next);
    });
    var lead = /^\s*/.exec(inner)[0];
    var trail = /\s*$/.exec(inner)[0];
    var core = inner.slice(lead.length, inner.length - trail.length);
    if (!core) return inner;
    // Applied innermost first, italic outermost: renderNote() reads bold first and italic last, so ***x*** works.
    if (want.b && !on.b) core = '**' + core + '**';
    if (want.u && !on.u) core = '__' + core + '__';
    if (want.s && !on.s) core = '~~' + core + '~~';
    if (want.i && !on.i) core = '*' + core + '*';
    return lead + core + trail;
  }

  function textOf(node) {
    var t = '';
    kids(node).forEach(function (k) {
      t += inlineOf(k, {});
    });
    return t;
  }
  // Plain text without marks (headings: a heading is "**text**", so marks inside it would break it).
  function plainOf(node) {
    if (node.nodeType === 3) return String(node.nodeValue || '').replace(/ /g, ' ');
    if (node.nodeType !== 1 || hasClass(node, 'hash')) return '';
    if (tagOf(node) === 'BR') return ' ';
    var t = '';
    kids(node).forEach(function (k) {
      t += plainOf(k);
    });
    return t;
  }
  function oneLine(s) {
    return String(s).replace(/\s*\n\s*/g, ' ').replace(/[ \t]+/g, ' ').trim();
  }
  function push(kind, text, extra) {
    lines.push({ kind: kind, text: text, numbered: extra ? extra.numbered : false, depth: extra ? extra.depth : 0 });
  }

  function list(node, numbered, depthBase, counters) {
    kids(node).forEach(function (k) {
      var tag = tagOf(k);
      if (tag === 'UL' || tag === 'OL') {
        list(k, tag === 'OL', Math.min(2, depthBase + 1), counters);
        return;
      }
      if (tag !== 'LI') {
        var stray = oneLine(k.nodeType === 3 ? k.nodeValue : textOf(k));
        if (stray) push('p', stray);
        return;
      }
      var depth = depthBase + (hasClass(k, 'd2') ? 2 : hasClass(k, 'd1') ? 1 : 0);
      if (depth > 2) depth = 2;
      var text = oneLine(textOf(k));
      if (text) {
        for (var d = depth + 1; d < 3; d++) counters[d] = 0;
        // A numbered list keeps its numbers: renderNote() writes each item's number as value="N", so a list that a paragraph
        // interrupted ("1. a / 2. b / note / 3. c") continues at 3. Only the first item of a run sets the start: later items
        // are counted on, because a browser copies value="N" onto the new item when Enter splits one.
        var start = numbered && k.getAttribute ? Number(k.getAttribute('value')) : 0;
        if (!counters[depth] && start >= 1 && start <= 999 && start === Math.floor(start)) counters[depth] = start - 1;
        counters[depth] = (counters[depth] || 0) + 1;
        push('li', INDENT[depth] + (numbered ? counters[depth] + '. ' : '- ') + text, { numbered: numbered, depth: depth });
      }
      kids(k).forEach(function (n) {
        var t = tagOf(n);
        if (t === 'UL' || t === 'OL') list(n, t === 'OL', Math.min(2, depth + 1), counters);
      });
    });
  }

  function block(node) {
    var tag = tagOf(node);
    if (node.nodeType === 3) {
      var loose = oneLine(node.nodeValue);
      if (loose) push('p', loose);
      return;
    }
    if (node.nodeType !== 1 || tag === 'BR') return;
    if (/^H[1-6]$/.test(tag)) {
      var h = oneLine(plainOf(node)).replace(/\*/g, '');
      if (h) push('h', '**' + h + '**');
      return;
    }
    if (tag === 'UL' || tag === 'OL') {
      list(node, tag === 'OL', 0, [0, 0, 0]);
      return;
    }
    if (tag === 'BLOCKQUOTE') {
      var inner = kids(node).some(function (k) {
        return /^(P|DIV|H[1-6]|UL|OL|BLOCKQUOTE)$/.test(tagOf(k));
      });
      var parts = inner
        ? kids(node).map(function (k) {
            return k.nodeType === 3 ? k.nodeValue : textOf(k);
          })
        : [textOf(node)];
      parts.forEach(function (p) {
        String(p)
          .split('\n')
          .forEach(function (l) {
            var q = oneLine(l);
            if (q) push('q', '> ' + q);
          });
      });
      return;
    }
    // P, DIV and anything else: a paragraph per line (Shift+Enter makes a line break inside one).
    var sub = hasClass(node, 'sub');
    var byline = hasClass(node, 'byline');
    textOf(node)
      .split('\n')
      .forEach(function (l) {
        var t = oneLine(l);
        if (!t) return;
        if (byline) push('byline', t.replace(/\*\*|__|~~|\*/g, ''));
        else push(sub ? 'sub' : 'p', (sub ? '-# ' : '') + t);
      });
  }

  kids(root).forEach(block);

  // A blank line before each heading and the byline, after a list, and between a bulleted and a numbered list, as the
  // generated notes have them.
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    var prev = lines[i - 1];
    var listSwitch = prev && prev.kind === 'li' && l.kind === 'li' && l.depth === 0 && prev.numbered !== l.numbered;
    if (prev && (l.kind === 'h' || l.kind === 'byline' || (prev.kind === 'li' && l.kind !== 'li') || listSwitch)) out.push('');
    out.push(l.text);
  }
  return out.join('\n').trim();
}`;
