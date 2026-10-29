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
#
# 終了コード: 0=クリーン / 1=違反検出 / 2=使用方法エラー
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

# 走査から除外するパス（denylist 語・パターン例を正当に含むファイル）
# 注: scan-secrets.ts は除外しない（盲点を作らない）。同ファイルのパターン定義は正規表現メタを
# 含むため自己マッチせず、selftest の fake secret は連結で組み立てるため contiguous な literal を残さない。
EXCLUDE_PATHS=(
  "scripts/pii-guard.patterns.txt"
  "scripts/pii-guard.patterns.local.txt"
  "scripts/pii-guard.sh"
  ".github/workflows/pii-guard.yml"
)

# 実在しうるメールアドレスの混入検出。予約ドメイン（RFC 2606 / 6761）と noreply のみ許可。
EMAIL_RE='[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+'
# 実在ドメインは許可しない。コミットの共著者表記に使う固定の noreply アドレスだけ完全一致で通す。
EMAIL_ALLOW_RE='@(([A-Za-z0-9-]+\.)*example\.(com|org|net)|[A-Za-z0-9.-]+\.(invalid|test|example|localhost)|users\.noreply\.github\.com|noreply\.github\.com)$|(^|:)noreply@anthropic\.com$' 

if [[ ! -f "$PATTERNS_FILE" ]]; then
  echo "pii-guard: patterns file not found: $PATTERNS_FILE" >&2
  exit 2
fi

# コメント/空行を除いた有効パターンを一時ファイルに展開（grep -f 用）。
# denylist（PII/痕跡）に加え、高シグナルな secret パターンを組み込みで付加する
# （第三者 action に依存せず secret 流入も同じ経路で遮断するため）。
CLEAN_PATTERNS="$(mktemp)"
trap 'rm -f "$CLEAN_PATTERNS"' EXIT
grep -vE '^[[:space:]]*(#|$)' "$PATTERNS_FILE" > "$CLEAN_PATTERNS" || true
# プロジェクト固有 denylist（gitignore 対象・存在すれば追加）。公開 repo には無いため
# CI では汎用パターンのみ、ローカル/移行作業中は識別情報も照合する。
if [[ -f "$LOCAL_PATTERNS_FILE" ]]; then
  grep -vE '^[[:space:]]*(#|$)' "$LOCAL_PATTERNS_FILE" >> "$CLEAN_PATTERNS" || true
fi
cat >> "$CLEAN_PATTERNS" <<'EOF'
ghp_[A-Za-z0-9]{20,}
github_pat_[A-Za-z0-9_]{20,}
gho_[A-Za-z0-9]{20,}
AKIA[0-9A-Z]{16}
-----BEGIN [A-Z ]*PRIVATE KEY-----
xox[baprs]-[A-Za-z0-9-]{10,}
EOF

is_excluded() {
  local f="$1" p
  for p in "${EXCLUDE_PATHS[@]}"; do
    [[ "$f" == "$p" ]] && return 0
  done
  return 1
}

# stdin のテキストを走査。マッチを表示し、見つかれば 1 を返す。
grep_text() {
  local input; input="$(cat)"
  printf '%s\n' "$input" | grep -inEi -f "$CLEAN_PATTERNS" || true
  printf '%s\n' "$input" | grep -noE "$EMAIL_RE" | grep -viE "$EMAIL_ALLOW_RE" || true
}

scan_staged() {
  local found=0 f out
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    is_excluded "$f" && continue
    out="$(git show ":$f" 2>/dev/null | grep_text)"
    if [[ -n "$out" ]]; then
      echo "  ✗ $f"; echo "$out" | sed 's/^/      /'
      found=1
    fi
  done < <(git diff --cached --name-only --diff-filter=ACM)
  return $found
}

scan_message() {
  local file="$1" out
  [[ -f "$file" ]] || { echo "pii-guard: message file not found: $file" >&2; return 2; }
  # コメント行(#)を除いた本文を走査
  out="$(grep -vE '^[[:space:]]*#' "$file" | grep_text)"
  if [[ -n "$out" ]]; then
    echo "  ✗ commit message"; echo "$out" | sed 's/^/      /'
    return 1
  fi
  return 0
}

scan_tree() {
  local args=() p
  for p in "${EXCLUDE_PATHS[@]}"; do args+=(":(exclude)$p"); done
  local rc=0
  if git grep -inEi -f "$CLEAN_PATTERNS" -- . "${args[@]}" 2>/dev/null; then rc=1; fi
  if git grep -noE "$EMAIL_RE" -- . "${args[@]}" 2>/dev/null | grep -viE "$EMAIL_ALLOW_RE"; then rc=1; fi
  return $rc
}

check_identities() {
  local range="$1" bad=0 ae ce h
  while IFS='|' read -r ae ce h; do
    [[ -z "$h" ]] && continue
    if ! printf '%s' "$ae" | grep -qE "$ALLOWED_EMAIL_RE"; then
      echo "  ✗ $h: author email not allowed: $ae"; bad=1
    fi
    if ! printf '%s' "$ce" | grep -qE "$ALLOWED_EMAIL_RE"; then
      echo "  ✗ $h: committer email not allowed: $ce"; bad=1
    fi
  done < <(git log --format='%ae|%ce|%h' "$range" 2>/dev/null)
  return $bad
}

check_config() {
  local email; email="$(git config user.email || true)"
  if ! printf '%s' "$email" | grep -qE "$ALLOWED_EMAIL_RE"; then
    echo "  ✗ 現在の git user.email が許可外です: '${email:-(未設定)}'" >&2
    echo "    このリポジトリでは noreply の identity を使ってください:" >&2
    echo "    git config user.name <github-handle> && git config user.email <id>+<github-handle>@users.noreply.github.com" >&2
    return 1
  fi
  return 0
}

scan_range() {
  local base="$1" tip="$2" rc=0
  # identity
  if ! check_identities "${base}..${tip}"; then rc=1; fi
  # 内容（範囲の差分追加行を走査）。除外パスは self-match を避けるため diff から外す。
  local exargs=() p
  for p in "${EXCLUDE_PATHS[@]}"; do exargs+=(":(exclude)$p"); done
  local out
  out="$(git diff "${base}" "${tip}" -- . "${exargs[@]}" 2>/dev/null \
        | grep -E '^\+' | grep -vE '^\+\+\+' | grep_text)"
  if [[ -n "$out" ]]; then
    echo "  ✗ push 範囲の追加内容に痕跡:"; echo "$out" | sed 's/^/      /'
    rc=1
  fi
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
  *)
    echo "usage: pii-guard.sh {scan-staged|scan-message <f>|scan-tree|check-identities <range>|check-config|scan-range <base> <tip>}" >&2
    exit 2 ;;
esac
