#!/usr/bin/env bash
# =============================================================================
# pii-guard.sh — PII / 内部痕跡の混入を commit / push / merge の各段で防ぐ共有ガード。
#
# git hooks（.githooks/*）と CI（.github/workflows/pii-guard.yml）の双方から呼ばれる
# 単一の実装。denylist は scripts/pii-guard.patterns.txt（SSOT）。
#
# サブコマンド:
#   scan-staged            staged 内容（追加/変更ファイルのstaged blob）を走査
#   scan-message <file>    commit メッセージファイルを走査
#   scan-tree              tracked 全ファイルを走査（CI 用）
#   check-identities <rev-range|--all>
#                          指定範囲のコミットの author/committer email を allowlist 照合
#   check-config           現在の git user.email が allowlist に合致するか
#   scan-range <base> <tip>
#                          base..tip のコミット内容 + identity を走査（pre-push 用）
#   scan-commits <rev-range>
#                          範囲の各コミットについて、追加行とコミットメッセージを 1 件ずつ走査（CI 用）。
#                          途中で足して後で消した内容も、差分の合計では消えて見えるため 1 件ずつ見る。
#                          範囲に 1 つのリビジョン（例: HEAD）を渡すと root コミットまで含む。
#
# 終了コード: 0=クリーン / 1=違反検出 / 2=使用方法エラー・git の失敗（検出なしとは区別する）
#
# ローカルでの一時バイパス（hooks のみ。CI は不可）: 環境変数 PII_GUARD_SKIP=1
# =============================================================================
set -euo pipefail

GUARD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATTERNS_FILE="${GUARD_DIR}/pii-guard.patterns.txt"
# プロジェクト固有 PII/痕跡の denylist（gitignore 対象・公開 repo には含めない）。
# 存在すれば追加読込し、ローカル開発・移行作業中の識別情報混入を捕捉する。
LOCAL_PATTERNS_FILE="${GUARD_DIR}/pii-guard.patterns.local.txt"

# author/committer に許可する email（GitHub noreply のみ）
ALLOWED_EMAIL_RE='@users\.noreply\.github\.com$|^noreply@github\.com$'

# 走査から除外するパス（denylist 語・パターン例を正当に含むファイル）。
# ガード本体・ワークフロー・テストは除外しない（盲点を作らない）。fake secret は連結で組み立てる。
EXCLUDE_PATHS=(
  "scripts/pii-guard.patterns.txt"
  "scripts/pii-guard.patterns.local.txt"
)

# 実在しうるメールアドレスの混入検出。予約ドメイン（RFC 2606 / 6761）と noreply のみ許可。
# AGENTS.md の例外（AI ツールの共著者行）は、アドレスではなく共著者行の形で許可する（strip_coauthor）。
EMAIL_RE='[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+'
EMAIL_ALLOW_RE='@(example\.(com|org|net)|[A-Za-z0-9.-]+\.(invalid|test|example|localhost)|users\.noreply\.github\.com|noreply\.github\.com)$'

if [[ ! -f "$PATTERNS_FILE" ]]; then
  echo "pii-guard: patterns file not found: $PATTERNS_FILE" >&2
  exit 2
fi

# コメント/空行を除いた有効パターンを一時ファイルに展開（grep -f 用）。
# denylist（PII/痕跡）に加え、高シグナルな secret パターンを組み込みで付加する
# （第三者 action に依存せず secret 流入も同じ経路で遮断するため）。
CLEAN_PATTERNS="$(mktemp)"
trap 'rm -f "$CLEAN_PATTERNS"' EXIT
load_patterns() {
  local rc=0
  grep -vE '^[[:space:]]*(#|$)' "$1" >> "$CLEAN_PATTERNS" || rc=$?
  if (( rc > 1 )); then
    echo "pii-guard: パターンを読めません: $1" >&2
    exit 2
  fi
}
load_patterns "$PATTERNS_FILE"
# プロジェクト固有 denylist（gitignore 対象・存在すれば追加）。公開 repo には無いため
# CI では汎用パターンのみ、ローカル/移行作業中は識別情報も照合する。
if [[ -f "$LOCAL_PATTERNS_FILE" ]]; then
  load_patterns "$LOCAL_PATTERNS_FILE"
fi
# shared/sanitize.js の secret 規則と同じ形を揃える（片方だけが検出する食い違いを作らない）。
# 照合は大文字小文字を区別しないので、短い接頭辞は直前が英数字でないことを条件にする。
cat >> "$CLEAN_PATTERNS" <<'EOF'
(^|[^A-Za-z0-9])gh[opsur]_[A-Za-z0-9]{20,}
github_pat_[A-Za-z0-9_]{20,}
(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}
(^|[^A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}
AKIA[0-9A-Z]{16}
-----BEGIN [A-Z ]*PRIVATE KEY-----
xox[baprs]-[A-Za-z0-9-]{10,}
EOF

# 壊れた正規表現で grep が失敗すると、どのファイルでも「検出なし」に見える。走査の前に止める。
pattern_check=0
grep -Ei -f "$CLEAN_PATTERNS" </dev/null >/dev/null || pattern_check=$?
if (( pattern_check > 1 )); then
  echo "pii-guard: パターンに誤りがあります" >&2
  exit 2
fi

is_excluded() {
  local f="$1" p
  for p in "${EXCLUDE_PATHS[@]}"; do
    [[ "$f" == "$p" ]] && return 0
  done
  return 1
}

# AGENTS.md の例外を消す: AI ツールの共著者行が行全体のもの（差分の + は可）と、AGENTS.md の説明の表記。
# 名前を限るのは、実在の人名を同じ形で通さないため。
strip_coauthor() {
  sed -E -e 's/^\+?[[:space:]]*[Cc]o-[Aa]uthored-[Bb]y: Claude[ A-Za-z0-9.-]* <noreply@anthropic\.com>[[:space:]]*$//' \
    -e 's/`Co-Authored-By: … <noreply@anthropic\.com>`//g'
}

# stdin のテキストから許可外のアドレスを表示する。grep の失敗は 2 を返す（検出なしと区別する）。
grep_emails() {
  local rc=0 emails
  emails="$(strip_coauthor | grep -noE "$EMAIL_RE")" || rc=$?
  if (( rc > 1 )); then return 2; fi
  [[ -z "$emails" ]] && return 0
  rc=0
  printf '%s\n' "$emails" | grep -viE "$EMAIL_ALLOW_RE" || rc=$?
  if (( rc > 1 )); then return 2; fi
  return 0
}

# stdin のテキストを走査してマッチを表示する。grep の失敗は 2 を返す。
grep_text() {
  local input rc=0; input="$(cat)"
  printf '%s\n' "$input" | grep -inEi -f "$CLEAN_PATTERNS" || rc=$?
  if (( rc > 1 )); then return 2; fi
  printf '%s\n' "$input" | grep_emails
}

scan_staged() {
  local found=0 f content out names
  # R も含める（リネームと同時に足した内容を見逃さない）。-z で core.quotepath に関係なく実名で受け取る。
  if ! names="$(git diff --cached --name-only --diff-filter=ACMR -z | tr '\0' '\n')"; then
    echo "pii-guard: staged のファイル一覧を取得できません" >&2
    return 2
  fi
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    is_excluded "$f" && continue
    if ! content="$(git show ":$f")"; then
      echo "pii-guard: staged の内容を読めません: $f" >&2
      return 2
    fi
    out="$(printf '%s\n' "$content" | grep_text)"
    if [[ -n "$out" ]]; then
      echo "  ✗ $f"; echo "$out" | sed 's/^/      /'
      found=1
    fi
  done <<< "$names"
  return $found
}

scan_message() {
  local file="$1" out
  [[ -f "$file" ]] || { echo "pii-guard: message file not found: $file" >&2; return 2; }
  # コメント行(#)を除いた本文を走査
  out="$({ grep -vE '^[[:space:]]*#' "$file" || (( $? == 1 )); } | grep_text)"
  if [[ -n "$out" ]]; then
    echo "  ✗ commit message"; echo "$out" | sed 's/^/      /'
    return 1
  fi
  return 0
}

scan_tree() {
  local args=() p
  for p in "${EXCLUDE_PATHS[@]}"; do args+=(":(exclude)$p"); done
  local rc=0 status=0 files f out line
  git grep -inEi -f "$CLEAN_PATTERNS" -- . "${args[@]}" || status=$?
  case "$status" in
    0) rc=1 ;;
    1) ;;
    *) echo "pii-guard: tracked ファイルを走査できません" >&2; return 2 ;;
  esac
  status=0
  files="$(git grep -lzE "$EMAIL_RE" -- . "${args[@]}" | tr '\0' '\n')" || status=$?
  if (( status > 1 )); then
    echo "pii-guard: tracked ファイルを走査できません" >&2
    return 2
  fi
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    out="$(grep_emails < "$f")"
    [[ -z "$out" ]] && continue
    while IFS= read -r line; do echo "$f:$line"; done <<< "$out"
    rc=1
  done <<< "$files"
  return $rc
}

check_identities() {
  local range="$1" bad=0 ae ce h log
  # プロセス置換にすると git log の失敗が見えず、範囲が不正でも通ってしまう。
  if ! log="$(git log --format='%ae|%ce|%h' "$range")"; then
    echo "pii-guard: コミットの一覧を取得できません: $range" >&2
    return 2
  fi
  while IFS='|' read -r ae ce h; do
    [[ -z "$h" ]] && continue
    if ! printf '%s' "$ae" | grep -qE "$ALLOWED_EMAIL_RE"; then
      echo "  ✗ $h: author email not allowed: $ae"; bad=1
    fi
    if ! printf '%s' "$ce" | grep -qE "$ALLOWED_EMAIL_RE"; then
      echo "  ✗ $h: committer email not allowed: $ce"; bad=1
    fi
  done <<< "$log"
  return $bad
}

check_config() {
  local email; email="$(git config user.email || true)"
  if ! printf '%s' "$email" | grep -qE "$ALLOWED_EMAIL_RE"; then
    echo "  ✗ 現在の git user.email が許可外です: '${email:-(未設定)}'" >&2
    echo "    このリポジトリでは noreply の identity を使ってください:" >&2
    echo "    git config user.name hryknkmr && git config user.email hryknkmr@users.noreply.github.com" >&2
    return 1
  fi
  return 0
}

scan_range() {
  local base="$1" tip="$2" rc=0 status=0
  # identity
  # pre-push は root からの push で base に空ツリーを渡す。ツリーは範囲の始点にできない。
  if [[ "$(git cat-file -t "$base" 2>/dev/null)" == "tree" ]]; then
    check_identities "$tip" || status=$?
  else
    check_identities "${base}..${tip}" || status=$?
  fi
  if (( status > 1 )); then return 2; fi
  if (( status == 1 )); then rc=1; fi
  # 内容（範囲の差分追加行を走査）。除外パスは self-match を避けるため diff から外す。
  local exargs=() p
  for p in "${EXCLUDE_PATHS[@]}"; do exargs+=(":(exclude)$p"); done
  local diff out
  # git diff の失敗は「検出なし」と区別して止める。追加行が 0 件（削除だけ）は正常。
  if ! diff="$(git diff "${base}" "${tip}" -- . "${exargs[@]}")"; then
    echo "pii-guard: ${base}..${tip} の差分を取得できません" >&2
    return 2
  fi
  out="$(printf '%s\n' "$diff" | { grep -E '^\+' || true; } | { grep -vE '^\+\+\+' || true; } | grep_text)"
  if [[ -n "$out" ]]; then
    echo "  ✗ push 範囲の追加内容に痕跡:"; echo "$out" | sed 's/^/      /'
    rc=1
  fi
  return $rc
}

scan_commits() {
  local range="$1" rc=0 h exargs=() p list patch msg out
  for p in "${EXCLUDE_PATHS[@]}"; do exargs+=(":(exclude)$p"); done
  if ! list="$(git rev-list "$range")"; then
    echo "pii-guard: コミットの一覧を取得できません: $range" >&2
    return 2
  fi
  while IFS= read -r h; do
    [[ -z "$h" ]] && continue
    # --root: root コミットも「空からの追加」として差分を出す。-m --first-parent: マージは取り込んだ側の変更として見る。
    if ! patch="$(git show --root -m --first-parent --format= "$h" -- . "${exargs[@]}")"; then
      echo "pii-guard: コミットの差分を取得できません: $h" >&2
      return 2
    fi
    out="$(printf '%s\n' "$patch" | { grep -E '^\+' || true; } | { grep -vE '^\+\+\+' || true; } | grep_text)"
    if [[ -n "$out" ]]; then
      echo "  ✗ ${h:0:7} の追加内容:"; echo "$out" | sed 's/^/      /'
      rc=1
    fi
    if ! msg="$(git log -1 --format=%B "$h")"; then
      echo "pii-guard: コミットメッセージを取得できません: $h" >&2
      return 2
    fi
    out="$(printf '%s\n' "$msg" | grep_text)"
    if [[ -n "$out" ]]; then
      echo "  ✗ ${h:0:7} のコミットメッセージ:"; echo "$out" | sed 's/^/      /'
      rc=1
    fi
  done <<< "$list"
  return $rc
}

cmd="${1:-}"; shift || true
case "$cmd" in
  scan-staged)       scan_staged ;;
  scan-message)      scan_message "${1:?usage: scan-message <file>}" ;;
  scan-tree)         scan_tree ;;
  check-identities)  check_identities "${1:?usage: check-identities <range|--all>}" ;;
  check-config)      check_config ;;
  scan-range)        scan_range "${1:?base}" "${2:?tip}" ;;
  scan-commits)      scan_commits "${1:?usage: scan-commits <rev-range>}" ;;
  *)
    echo "usage: pii-guard.sh {scan-staged|scan-message <f>|scan-tree|check-identities <range>|check-config|scan-range <base> <tip>|scan-commits <range>}" >&2
    exit 2 ;;
esac
