/**
 * op-scribe - what a screen is for, and what an operation on it means.
 *
 * Pure functions over the features content/recorder.js extracts from the DOM
 * (title, forms, buttons, repeated links, ...). Kept free of DOM access so
 * the rules can be unit tested and run in the service worker.
 * Classic script for the same reasons as shared/sanitize.js.
 */
(function (root) {
  'use strict';

  const LABELS = {
    search: '検索',
    create: '作成・投稿',
    update: '編集・保存',
    delete: '削除',
    auth: 'ログイン・会員登録',
    purchase: '購入・決済',
    output: '出力・共有',
    social: '反応（フォロー・スキ・コメントなど）',
    form: '情報の入力',
    list: '一覧の閲覧',
    detail: '詳細の閲覧',
    dismiss: '閉じる・中止',
    browse: '閲覧'
  };

  // First match wins, so the more specific intents come first.
  const VERBS = [
    ['auth', /ログイン|ログアウト|サインイン|サインアウト|新規登録|会員登録|パスワードを忘れ|log ?in|log ?out|sign ?in|sign ?out|sign ?up|register/i],
    ['purchase', /購入|カート|決済|支払|注文|購読|チップ|buy|purchase|checkout|\bcart\b|\border\b|subscribe|\bpay\b/i],
    ['dismiss', /キャンセル|閉じる|戻る|やめる|\bcancel\b|\bclose\b|\bback\b/i],
    ['delete', /削除|消去|退会|解除|delete|remove|unsubscribe/i],
    ['output', /ダウンロード|エクスポート|出力|印刷|共有|シェア|コピー|埋め込|download|export|print|share|copy|embed/i],
    ['create', /新規|作成|追加|投稿|公開|書く|つくる|作る|アップロード|\bnew\b|create|\badd\b|\bpost\b|publish|upload|compose|\bwrite\b/i],
    ['update', /保存|更新|編集|変更|設定|適用|下書き|\bsave\b|update|\bedit\b|change|apply|settings/i],
    ['search', /検索|絞り込|フィルタ|並び替|search|filter|\bsort\b|\bfind\b/i],
    ['social', /フォロー|スキ|いいね|コメント|返信|follow|\blike\b|comment|reply/i]
  ];

  const PATH_HINTS = [
    ['search', /\/search\b/i],
    ['create', /\/(new|create|compose|post)\b/i],
    ['update', /\/(edit|settings?|preferences)\b/i],
    ['auth', /\/(log_?in|sign_?in|sign_?up|signup|register|auth)\b/i],
    ['purchase', /\/(cart|checkout|purchase|payment|order)s?\b/i],
    ['list', /\/(list|archive|ranking|trend|category|tags?|search)\b|一覧|ランキング|急上昇|新着|おすすめ/i]
  ];

  /** Intent of a single label such as a button or link text, or null. */
  function intentOf(text) {
    const value = String(text || '');
    if (!value) return null;
    for (const [kind, re] of VERBS) if (re.test(value)) return kind;
    return null;
  }

  function pathOf(url) {
    try { return new URL(url).pathname; } catch { return String(url || ''); }
  }

  /**
   * @param {object} f features from content/recorder.js (already masked)
   * @returns {{ purposes: {kind,label,score,reasons}[], summary: string }}
   */
  function classifyScreen(f = {}) {
    const scores = new Map();
    const add = (kind, weight, reason) => {
      const entry = scores.get(kind) || { kind, label: LABELS[kind], score: 0, reasons: [] };
      entry.score += weight;
      if (reason && entry.reasons.length < 3 && !entry.reasons.includes(reason)) entry.reasons.push(reason);
      scores.set(kind, entry);
    };

    for (const form of f.forms || []) {
      if (form.kind === 'search') add('search', 3, '検索フォーム');
      if ((form.fields || []).some((field) => field.type === 'password')) add('auth', 3, 'パスワード欄');
      const fields = (form.fields || []).length;
      if (form.kind !== 'search' && fields >= 3) add('form', 2, `入力フォーム（${fields} 項目）`);
      const submitIntent = intentOf(form.submit);
      if (submitIntent && submitIntent !== 'dismiss') add(submitIntent, 2, `送信ボタン「${form.submit}」`);
    }

    if (f.editor) {
      add('create', 2, '本文エディタ');
      add('update', 1, '本文エディタ');
    }

    const perKind = new Map();
    for (const label of f.buttons || []) {
      const kind = intentOf(label);
      if (!kind || kind === 'dismiss') continue;
      const n = perKind.get(kind) || 0;
      if (n >= 3) continue;
      perKind.set(kind, n + 1);
      add(kind, 1, `ボタン「${label}」`);
    }

    const path = pathOf(f.url);
    for (const [kind, re] of PATH_HINTS) if (re.test(path)) add(kind, 2, `URL（${path}）`);
    for (const text of [f.title, f.h1]) {
      const kind = intentOf(text);
      if (kind && kind !== 'dismiss') add(kind, 1, '画面タイトル');
      if (/一覧|ランキング|急上昇|新着|おすすめ|ranking|trend|archive/i.test(text || '')) add('list', 1, '画面タイトル');
    }

    if (f.repeated && f.repeated.count >= 5) add('list', 3, `同じ形のリンクが ${f.repeated.count} 件`);
    if ((f.tables || 0) > 0) add('list', 1, `表 ${f.tables} 個`);
    // On a list page the long text is the cards themselves, not a body to read.
    const listLike = f.repeated && f.repeated.count >= 5;
    if (f.article || (!listLike && (f.textLength || 0) >= 1500)) {
      add('detail', 2, f.article ? '記事本文' : `本文 約${Math.round((f.textLength || 0) / 100) * 100} 文字`);
    }

    const purposes = [...scores.values()]
      .filter((p) => p.score >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    if (!purposes.length) purposes.push({ kind: 'browse', label: LABELS.browse, score: 0, reasons: [] });
    return { purposes, summary: `${purposes.map((p) => p.label).join('・')}の画面` };
  }

  /** Short Japanese descriptions of the main UI parts, most informative first. */
  function describeComponents(f = {}) {
    const out = [];
    for (const form of (f.forms || []).slice(0, 3)) {
      const labels = (form.fields || []).map((field) => field.label).filter(Boolean).slice(0, 5);
      if (form.kind === 'search') {
        out.push(`検索フォーム${labels.length ? `（${labels.join('、')}）` : ''}`);
      } else {
        const name = form.name ? `「${form.name}」` : '';
        const submit = form.submit ? ` → 「${form.submit}」` : '';
        out.push(`入力フォーム${name}（${(form.fields || []).length} 項目${labels.length ? `: ${labels.join('、')}` : ''}）${submit}`);
      }
    }
    if (f.editor) out.push('本文エディタ');
    for (const dialog of (f.dialogs || []).slice(0, 2)) out.push(`ダイアログ${dialog ? `「${dialog}」` : ''}`);
    if (f.repeated && f.repeated.count >= 5) out.push(`一覧（同じ形のリンク ${f.repeated.count} 件）`);
    if ((f.tables || 0) > 0) out.push(`表 ${f.tables} 個`);
    if (f.article || (!(f.repeated && f.repeated.count >= 5) && (f.textLength || 0) >= 1500)) {
      out.push(`本文（約 ${Math.round((f.textLength || 0) / 100) * 100} 文字）`);
    }
    if ((f.navLinks || []).length) out.push(`ナビゲーション（${f.navLinks.slice(0, 6).join('、')}）`);
    else if (f.navCount) out.push(`ナビゲーション（リンク ${f.navCount} 件）`);
    if ((f.buttons || []).length) out.push(`ボタン（${f.buttons.slice(0, 6).join('、')}）`);
    if ((f.headings || []).length) out.push(`見出し（${f.headings.slice(0, 4).join('、')}）`);
    else if (f.headingCount) out.push(`見出し ${f.headingCount} 個`);
    return out.slice(0, 8);
  }

  const COMPONENT_LABELS = {
    search: '検索フォーム',
    form: 'フォーム',
    dialog: 'ダイアログ',
    nav: 'ナビゲーション',
    header: 'ヘッダー',
    footer: 'フッター',
    list: '一覧',
    aside: 'サイドバー',
    article: '記事本文',
    main: 'メインエリア'
  };

  /** "ヘッダー" / "一覧（24 件）" / "フォーム「お問い合わせ」" */
  function componentPhrase(component) {
    if (!component?.kind) return '';
    const base = COMPONENT_LABELS[component.kind] || component.kind;
    if (component.kind === 'list' && component.size) return `${base}（${component.size} 件）`;
    return component.name ? `${base}「${component.name}」` : base;
  }

  const api = { LABELS, intentOf, classifyScreen, describeComponents, componentPhrase };
  root.OpScribeScreen = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
