/**
 * op-scribe - feeding a screen to the on-device model piece by piece.
 *
 * A unit is the smallest part of a screen that carries its own name or role:
 * the page itself, a feedback message, a dialog, a form, a list, a titled
 * section, a landmark, or the change an operation caused. content/recorder.js
 * extracts them; this file decides what goes into each model call:
 *   - units are packed whole, most informative first, as many as fit;
 *   - a unit larger than one call is split at line / sentence boundaries
 *     into numbered pages, each carrying the unit's name.
 * Pure functions, so the packing can be unit tested.
 * Classic script for the same reasons as shared/sanitize.js.
 */
(function (root) {
  'use strict';

  const KINDS = {
    page: 'ページ',
    feedback: 'メッセージ',
    change: '操作後の変化',
    dialog: 'ダイアログ',
    form: 'フォーム',
    list: '一覧',
    section: '区画',
    landmark: '領域'
  };
  const PRIORITY = { page: 0, feedback: 1, change: 1, dialog: 2, form: 3, list: 4, section: 5, landmark: 6 };

  const header = (unit, part) => {
    const name = unit.name ? `「${unit.name}」` : '';
    const size = unit.kind === 'list' && unit.count ? `（${unit.count} 件）` : '';
    const page = part ? `（${part.index}/${part.total}）` : '';
    return `【${KINDS[unit.kind] || unit.kind}${name}${size}${page}】`;
  };

  const render = (unit, text = unit.text, part) => `${header(unit, part)}\n${text}`;

  /** Splits text into pieces of at most max characters, preferring line, then sentence, boundaries. */
  function splitText(text, max) {
    const pieces = [];
    let current = '';
    const flush = () => {
      if (current) pieces.push(current);
      current = '';
    };
    const atoms = String(text).split(/(?<=\n)|(?<=[。．！？!?])\s*/).filter(Boolean);
    for (let atom of atoms) {
      while (atom.length > max) {
        flush();
        pieces.push(atom.slice(0, max));
        atom = atom.slice(max);
      }
      if (current.length + atom.length > max) flush();
      current += atom;
    }
    flush();
    return pieces.map((p) => p.trim()).filter(Boolean);
  }

  /**
   * @param {{kind, name?, text, count?, order?}[]} units
   * @param {number} budget  characters one model call may read
   * @returns {string[]} pages; each is one or more rendered units, or one part of a large unit
   */
  function paginate(units, budget) {
    const sorted = [...(units || [])]
      .filter((u) => u && u.text)
      .sort((a, b) => (PRIORITY[a.kind] ?? 9) - (PRIORITY[b.kind] ?? 9) || (a.order ?? 0) - (b.order ?? 0));
    const pages = [];
    let page = '';
    const add = (block) => {
      if (page && page.length + 2 + block.length > budget) {
        pages.push(page);
        page = '';
      }
      page = page ? `${page}\n\n${block}` : block;
    };

    for (const unit of sorted) {
      const whole = render(unit);
      if (whole.length <= budget) {
        add(whole);
        continue;
      }
      // Too large for one call: split it, leaving room for the numbered header.
      const room = Math.max(budget - header(unit, { index: 99, total: 99 }).length - 1, 50);
      const parts = splitText(unit.text, room);
      parts.forEach((text, i) => add(render(unit, text, { index: i + 1, total: parts.length })));
    }
    if (page) pages.push(page);
    return pages;
  }

  /** Total characters, for deciding how much of a screen to read at all. */
  const size = (units) => (units || []).reduce((n, u) => n + (u.text?.length || 0), 0);

  const api = { KINDS, PRIORITY, render, splitText, paginate, size };
  root.OpScribeUnits = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
