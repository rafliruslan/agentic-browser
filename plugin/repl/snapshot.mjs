/**
 * Accessibility snapshot with stable refs, computed in the page.
 *
 * Playwright's own ref-bearing snapshot (`_snapshotForAI`) is internal and not
 * reachable from playwright-core's public API, and `ariaSnapshot({ref:true})`
 * accepts the option but emits no refs. So this walks the DOM itself and tags
 * each interesting element with `data-bref`, which makes every ref directly
 * resolvable afterwards by `page.locator('[data-bref="e42"]')`, no internals,
 * no version coupling, and the tag survives until the next snapshot.
 *
 * Refs are ours alone. `mcp__browser__*` emits `[ref=e12]` and `mcp__devtools__*`
 * emits `uid=1_21`; neither is interchangeable with these. Snapshot with the
 * server you are about to act with.
 */

/**
 * Runs inside the page. Must be self-contained: no imports, no closures.
 *
 * Takes a single object because page.evaluate passes exactly one argument and
 * serialises this function to run it; a second parameter would silently arrive
 * undefined.
 */
export function collect(input) {
  const { prevSerial = null, options } = input || {};
  const opts = options || {};
  const ROLE_BY_TAG = {
    A: 'link', BUTTON: 'button', INPUT: 'textbox', TEXTAREA: 'textbox',
    SELECT: 'combobox', IMG: 'img', H1: 'heading', H2: 'heading', H3: 'heading',
    H4: 'heading', H5: 'heading', H6: 'heading', NAV: 'navigation',
    MAIN: 'main', FORM: 'form', TABLE: 'table', TR: 'row', TD: 'cell',
    TH: 'columnheader', UL: 'list', OL: 'list', LI: 'listitem',
    DIALOG: 'dialog', SUMMARY: 'button', LABEL: 'label',
  };
  const INPUT_ROLE = {
    checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button',
    range: 'slider', file: 'button', search: 'searchbox',
  };

  // What you can actually click, type into, or focus. Everything else is
  // scaffolding that tells you where you are, which is worth paying for on the
  // first read of a page and not on the reads after it.
  const INTERACTIVE = new Set([
    'link','button','textbox','combobox','checkbox','radio','slider','searchbox',
    'tab','menuitem','option',
  ]);

  // Elements worth a ref even with no accessible name: containers give the tree
  // its shape, and an unnamed button is exactly the thing you need to click.
  const INTERESTING = new Set([
    'link','button','textbox','combobox','checkbox','radio','slider','searchbox',
    'heading','listitem','row','cell','columnheader','tab','menuitem','option',
    'dialog','alert','img','main','navigation','form','table','list',
  ]);

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().split(/\s+/)[0];
    if (el.tagName === 'INPUT') return INPUT_ROLE[el.type] || 'textbox';
    return ROLE_BY_TAG[el.tagName] || '';
  }

  function nameOf(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const parts = by.split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((n) => n.textContent.trim());
      if (parts.length) return parts.join(' ');
    }
    if (el.tagName === 'IMG') return (el.getAttribute('alt') || '').trim();
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      return (el.getAttribute('placeholder') || el.getAttribute('title') || '').trim();
    }
    // Own text nodes first, so a wrapper does not inherit its whole subtree.
    let own = '';
    for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent + ' ';
    own = own.replace(/\s+/g, ' ').trim();
    if (own) return own;

    // Controls usually carry their label in nested spans. Google's buttons are
    // icon span + text span + arrow span, which own-text-only reads as unnamed.
    // Descend for those, joining with spaces so "add" + "Create" does not
    // become "addCreate", and drop Material icon ligatures which are glyph
    // names rather than words a person sees.
    const LABELLED = new Set(['button','link','tab','menuitem','option','cell','columnheader','heading','listitem','checkbox','radio']);
    const role = roleOf(el);
    if (LABELLED.has(role)) {
      const parts = [];
      const walkText = (node, depth) => {
        if (depth > 6 || parts.join(' ').length > 140) return;
        for (const n of node.childNodes) {
          if (n.nodeType === 3) {
            const t = n.textContent.replace(/\s+/g, ' ').trim();
            if (t) parts.push(t);
          } else if (n.nodeType === 1) {
            if (n.getAttribute('aria-hidden') === 'true') continue;
            const cls = String(n.className || '');
            if (/material-icons|google-symbols|icon\b/i.test(cls)) continue;
            walkText(n, depth + 1);
          }
        }
      };
      walkText(el, 0);
      const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
      if (joined) return joined.slice(0, 140);
    }
    return '';
  }

  /**
   * Whether the subtree is genuinely gone. Only these stop the walk.
   *
   * Zero size deliberately does NOT stop it: popups are routinely anchored to a
   * 0x0 element with an absolutely-positioned child, and treating that as
   * hidden silently drops the entire menu. Measured on Google Calendar, where
   * the whole Create menu was missing from the snapshot while being plainly
   * visible on screen at 140x32.
   */
  function pruned(el) {
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
    const s = window.getComputedStyle(el);
    return s.display === 'none' || s.visibility === 'hidden';
  }

  /** Whether this element itself is worth a line. */
  function onScreen(el) {
    const s = window.getComputedStyle(el);
    if (s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function stateOf(el, role) {
    const bits = [];
    if (el.getAttribute('aria-expanded') === 'true') bits.push('expanded');
    if (el.getAttribute('aria-selected') === 'true') bits.push('selected');
    if (el.getAttribute('aria-checked') === 'true' || (el.tagName === 'INPUT' && el.checked)) bits.push('checked');
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') bits.push('disabled');
    if (el === document.activeElement) bits.push('focused');
    if (role === 'heading') {
      const lvl = el.getAttribute('aria-level') || (/^H(\d)$/.test(el.tagName) ? el.tagName[1] : '');
      if (lvl) bits.push(`level=${lvl}`);
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const v = (el.value || '').trim();
      if (v) bits.push(`value=${JSON.stringify(v.slice(0, 80))}`);
    }
    return bits;
  }

  // Resolve the scope BEFORE clearing, since the ref being scoped to is one of
  // the tags about to be removed. A ref that has already expired is reported
  // rather than silently widened to the whole page, which would return the
  // opposite of what was asked for at the worst possible moment.
  let root = document.body;
  if (opts.ref) {
    const found = document.querySelector(`[data-bref="${String(opts.ref).replace(/"/g, '')}"]`);
    if (!found) {
      return { serial: '', count: 0, url: location.href, title: document.title, diff: null, missingRef: opts.ref };
    }
    root = found;
  }

  // Clear tags from the previous snapshot so refs never silently outlive it.
  for (const old of document.querySelectorAll('[data-bref]')) old.removeAttribute('data-bref');

  const lines = [];
  let n = 0;

  function walk(el, depth) {
    if (depth > 40) return;
    if (pruned(el)) return;
    const role = roleOf(el);
    const shown = onScreen(el);
    let emitted = false;

    const wanted = opts.interactive
      ? INTERACTIVE.has(role) || el.tabIndex >= 0
      : INTERESTING.has(role);

    if (shown && role && wanted) {
      const ref = `e${++n}`;
      el.setAttribute('data-bref', ref);
      const name = nameOf(el);
      const st = stateOf(el, role);
      lines.push(
        '  '.repeat(Math.min(depth, 12)) +
          `- ${role}${name ? ` ${JSON.stringify(name)}` : ''} [ref=${ref}]` +
          (st.length ? ` [${st.join('] [')}]` : ''),
      );
      emitted = true;
    }
    for (const child of el.children) walk(child, emitted ? depth + 1 : depth);
  }

  walk(root, 0);
  const serial = lines.join('\n');

  // Line-level diff. Cheap, and enough: a follow-up call usually needs to know
  // what appeared and what went away, not a structural edit script.
  let diff = null;
  if (typeof prevSerial === 'string') {
    const before = new Set(prevSerial.split('\n'));
    const after = new Set(lines);
    const added = lines.filter((l) => !before.has(l));
    const removed = prevSerial.split('\n').filter((l) => l && !after.has(l));
    diff = { added, removed, unchanged: lines.length - added.length };
  }

  return {
    serial,
    count: n,
    url: location.href,
    title: document.title,
    diff,
    scoped: opts.ref || null,
    interactive: Boolean(opts.interactive),
  };
}
