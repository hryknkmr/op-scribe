/**
 * op-scribe - how an element is named in a step (ADR 0003, row T2).
 *
 * Only elements a person operates (links, buttons, fields, ARIA widgets) are
 * named by the text they show. Anything else - body text, a margin, <main>,
 * <form>, <body> - is named only by what the author declared for it
 * (aria-label, aria-labelledby, title, alt), so clicking a paragraph never
 * copies the page's text into the recording.
 *
 * Runs in the content script; kept apart so the node tests can drive it with
 * plain objects. Classic script for the same reasons as shared/sanitize.js.
 */
(function (root) {
  'use strict';

  const { primaryRole } = root.OpScribeLimits || require('./limits.js');

  // Elements a person operates by their tag. No <label>: one without a control is page
  // text, and one with a control is recorded through the control it forwards the click to.
  const NATIVE = 'a[href], area[href], button, input, select, textarea, summary, [contenteditable=""], [contenteditable="true"]';
  // ARIA widget roles: elements a person operates, whatever their tag.
  const WIDGET_ROLES = new Set(['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'checkbox',
    'radio', 'switch', 'option', 'combobox', 'treeitem', 'slider', 'spinbutton', 'listbox', 'searchbox', 'textbox',
    'gridcell', 'scrollbar']);
  const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'tel', 'url', 'password', 'number',
    'date', 'datetime-local', 'month', 'week', 'time']);

  // Whitespace runs as one space, trimmed: a name as a reader sees it (not limits.js's oneLine).
  const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
  const textOf = (el) => squash(el.innerText ?? el.textContent ?? '');

  const isTextField = (el) => (el.tagName === 'INPUT' && TEXT_INPUT_TYPES.has(el.type))
    || el.tagName === 'TEXTAREA' || el.isContentEditable
    || ['textbox', 'searchbox'].includes(primaryRole(el.getAttribute('role')));

  /**
   * Whether a person operates this element: by its tag, or by the role it
   * actually takes - the first real token of role, never a later one
   * ("img button" is an image) (row T2).
   */
  const isOperated = (el) => el.matches(NATIVE) || WIDGET_ROLES.has(primaryRole(el.getAttribute('role')));

  /** The element a person operated, or null when the event hit page content. */
  const operated = (el) => {
    for (let node = el; node; node = node.parentElement) if (isOperated(node)) return node;
    return null;
  };

  /**
   * Whether the element is inside a search landmark, judged by each ancestor's
   * actual role - the role attribute, or the element's own (<search>; row I6, review R33).
   */
  const inSearch = (el) => {
    for (let node = el; node; node = node.parentElement) if (implicitRole(node) === 'search') return true;
    return false;
  };

  function implicitRole(el) {
    const explicit = el.getAttribute('role');
    const role = primaryRole(explicit);
    if (role) return role;
    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case 'a':
      case 'area': return el.hasAttribute('href') ? 'link' : 'generic';
      case 'button':
      case 'summary': return 'button';
      case 'select': return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      case 'textarea': return 'textbox';
      case 'img': return 'img';
      case 'input': {
        const type = el.type || 'text';
        if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
        if (type === 'checkbox' || type === 'radio') return type;
        if (type === 'range') return 'slider';
        if (type === 'search') return 'searchbox';
        return 'textbox';
      }
      default:
        if (el.isContentEditable) return 'textbox';
        if (/^h[1-6]$/.test(tag)) return 'heading';
        return tag;
    }
  }

  /**
   * Approximates the accessible name. Never reads the content of a field the
   * user types into - that is a value, not a name - and never reads the text
   * of an element nobody operates (row T2).
   */
  function accessibleName(el, doc) {
    const aria = el.getAttribute('aria-label');
    if (aria?.trim()) return squash(aria);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy && doc) {
      const text = labelledBy.split(/\s+/).map((id) => doc.getElementById(id))
        .filter(Boolean).map(textOf).join(' ');
      if (text) return text;
    }
    // An image, or a link of an image map, is named by its alt text (T2; review R34).
    if (el.tagName === 'IMG' || el.tagName === 'AREA') return squash(el.alt);
    const declared = squash(el.getAttribute('title'));
    if (!isOperated(el)) return declared;
    if (el.labels?.length) {
      const text = [...el.labels].map(textOf).join(' ');
      if (text) return text;
    }
    if (el.tagName === 'INPUT' && el.type === 'image') return squash(el.alt) || declared;
    if (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) return squash(el.value || el.type);
    if (el.matches('input, textarea, select') || isTextField(el) || implicitRole(el) === 'combobox') {
      // Never the name attribute: an identifier of the page, not something shown to a person (T2; review R44).
      return squash(el.getAttribute('placeholder') || declared);
    }
    return textOf(el) || squash(el.querySelector('img[alt]')?.alt) || declared;
  }

  const api = { isOperated, inSearch, isTextField, operated, implicitRole, accessibleName };
  root.OpScribeTarget = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
