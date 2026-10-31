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

  const INTERACTIVE = [
    // No <label>: one without a control is page text, and one with a control is
    // recorded through the control it forwards the click to.
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
    // ARIA widget roles: elements a person operates, whatever their tag.
    ...['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'checkbox', 'radio',
      'switch', 'option', 'combobox', 'treeitem', 'slider', 'spinbutton', 'listbox', 'searchbox',
      'textbox', 'gridcell', 'scrollbar'].map((role) => `[role="${role}"]`),
    '[contenteditable=""]', '[contenteditable="true"]'
  ].join(',');
  const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'tel', 'url', 'password', 'number',
    'date', 'datetime-local', 'month', 'week', 'time']);

  const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
  const textOf = (el) => oneLine(el.innerText ?? el.textContent ?? '');

  const isTextField = (el) => (el.tagName === 'INPUT' && TEXT_INPUT_TYPES.has(el.type))
    || el.tagName === 'TEXTAREA' || el.isContentEditable
    || ['textbox', 'searchbox'].includes(el.getAttribute('role'));

  /** The element a person operated, or null when the event hit page content. */
  const operated = (el) => (el ? el.closest(INTERACTIVE) : null);

  function implicitRole(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case 'a': return el.hasAttribute('href') ? 'link' : 'generic';
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
    if (aria?.trim()) return oneLine(aria);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy && doc) {
      const text = labelledBy.split(/\s+/).map((id) => doc.getElementById(id))
        .filter(Boolean).map(textOf).join(' ');
      if (text) return text;
    }
    if (el.tagName === 'IMG') return oneLine(el.alt);
    const declared = oneLine(el.getAttribute('title'));
    if (!el.matches(INTERACTIVE)) return declared;
    if (el.labels?.length) {
      const text = [...el.labels].map(textOf).join(' ');
      if (text) return text;
    }
    if (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) return oneLine(el.value || el.type);
    if (el.matches('input, textarea, select') || isTextField(el) || implicitRole(el) === 'combobox') {
      return oneLine(el.getAttribute('placeholder') || declared || el.getAttribute('name'));
    }
    return textOf(el) || oneLine(el.querySelector('img[alt]')?.alt) || declared;
  }

  const api = { INTERACTIVE, isTextField, operated, implicitRole, accessibleName };
  root.OpScribeTarget = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
