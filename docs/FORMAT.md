# 出力フォーマット

1 回の記録から 3 つの表現を作ります。中身は同じ操作列です。

| 表現 | 読み手 | 生成方法 | 編集 |
| --- | --- | --- | --- |
| 簡易手順（Markdown） | 人 | テンプレート、またはオンデバイス AI で整形 | 可 |
| Gherkin + 属性表 | AI エージェント・自動化 | 記録から機械的に生成（AI を通さない）。送信・コピー・保存のたびに作り直す | 不可 |
| steps（JSON） | プログラム | 記録そのもの | 不可（操作ログで削除のみ） |

## Gherkin + 属性表

通常の Gherkin（`Feature` / `Background` / `Scenario` / `Given` / `When` / `Then` / `And`）に、
**各ステップの Data Table として属性を付ける**形です。Gherkin のパーサでそのまま読め、
ステップ文だけでは失われる「どの画面の・どの要素か」を機械可読で残します。

```gherkin
# op-scribe: Gherkin + attributes
# recording: rec-mgx0abcd-1a2b3c / environments: commercial
# ‹…› and [[…]] are masked values: supply test values, never guess the original.
# site-N.invalid is an alias for a host that is not disclosed.
@op-scribe @env-commercial
Feature: 記録された操作の再現

  Background:
    Given "https://site-1.invalid/" を開いている
      | url    | https://site-1.invalid/ |
      | source | unknown |

  Scenario: 記録された操作
    When 「ログイン」リンクをクリックする
      | action   | click |
      | url      | https://site-1.invalid/ |
      | role     | link |
      | name     | ログイン |
      | tag      | a |
      | selector | [data-testid="login-link"] |
      | href     | https://site-1.invalid/login |
      | source   | user |
    Then "https://site-1.invalid/login" に遷移する
      | url    | https://site-1.invalid/login |
      | source | unknown |
    When 「メールアドレス」入力欄に ‹メールアドレス› を入力する
      | action   | input |
      | url      | https://site-1.invalid/login |
      | role     | textbox |
      | name     | メールアドレス |
      | selector | #email |
      | value    | [[email]] |
      | source   | user |
    And 「ログインする」ボタンをクリックする
      | action   | click |
      | url      | https://site-1.invalid/login |
      | role     | button |
      | name     | ログインする |
      | selector | form > button |
      | source   | user |
    Then "https://site-1.invalid/home" に遷移する
      | url    | https://site-1.invalid/home |
      | source | unknown |
    And ホーム画面にユーザーメニューが表示される
      | source | user |
```

### キーワードの割り当て

| キーワード | 何を表すか |
| --- | --- |
| `Given`（Background） | 記録開始時の画面 |
| `When` | ユーザー（または agent）の操作 1 つ |
| `Then` | 操作の直後 4 秒以内に起きた画面遷移、操作ログに追加した期待結果・確認点、操作の直後 5 秒以内のページの通知（`action` が `notice`。観測した事実で、期待結果ではない） |
| `And` | 直前と同じ種類が続くとき |

操作に起因しない遷移（アドレスバーへの直接入力など）は `When "…" を開く` になります。

### 属性（+α）

| 属性 | 内容 | 例 |
| --- | --- | --- |
| `action` | 操作種別 | `click` `input` `select` `check` `upload` `key` `tool` `navigate` `notice` |
| `url` | 操作した画面の URL（伏せ済み） | `https://site-1.invalid/orders/[[id]]` |
| `role` | 対象要素の ARIA ロール（明示 or 暗黙） | `button` `link` `textbox` `combobox` |
| `name` | 対象要素のアクセシブルネーム（伏せ済み・80 字まで） | `ログインする` |
| `tag` | HTML タグ名 | `button` |
| `selector` | 再特定用の CSS セレクタ。`data-testid` 等 → 安定した `id` → 4 階層までのパスの順で選ぶ。伏せる必要があった場合は出さない | `[data-testid="save"]` |
| `href` | リンク先（伏せ済み） | |
| `value` | 入力値（伏せ字のまま）。送信データでは型の付いた値で、ここで `[[…]]` に描画する | `[[text:12]]` `[[email]]` |
| `checked` | チェック操作後の状態 | `true` |
| `key` | 押したキー | `Enter` `meta+Enter` `Escape` |
| `tool` / `args` | 実行された WebMCP ツール名と引数（伏せ済み） | `search_catalog` / `{"q":"[[text:5]]"}` |
| `level` / `notice` | ページの通知の強さ（`status` / `alert`）と文（伏せ済み・200 字まで） | `alert` / `保存できませんでした` |
| `source` | 人の操作は `user`、WebMCP のツール呼び出し・追記は `agent`、タブの遷移とページの通知は `unknown`（人かページか見分けられない） | |

再現する側（人・AI）へのルール:

- 要素は `role` + `name` で探す（Playwright の `getByRole(role, { name, exact: true })` に対応）。一つに決まらない、または見つからない場合は `selector` を使い、なお曖昧なら推測して操作しない。
- `[[…]]` / `‹…›` は伏せた値。元の値を推測せず、テスト用の値を用意して入れる。`[[text:N]]` は N 文字程度の任意文字列。
- `site-N.invalid` は伏せたホストの別名。実ホストは記録した人に確認する。

## 簡易手順（Markdown）

```markdown
# 操作の再現手順（4 ステップ）

## 前提条件
- https://site-1.invalid にアクセスできる状態であること
- ‹…› で伏せた値（ログイン情報など）はテスト用の値を用意して入力すること

## 手順
1. https://site-1.invalid/ を開く
2. 「ログイン」リンクをクリックする
   - 期待結果: https://site-1.invalid/login に遷移する
...
```

## 探索メモ

Side Panel でメモの種類を選ぶと、`note` のステップに `kind`（`bug` / `question` / `idea` / `next`）が付きます。
種類のないメモは今までどおり期待結果と `Then` になります。種類のあるメモは手順の外に残します。

- Markdown: `## 探索メモ` の節に `- [不具合] 保存が2回走る（手順 1 の後）` の形で並ぶ。AI で整理したときは手順の番号を付けない
- Gherkin: その位置のコメント行 `# [不具合] 保存が2回走る` になる。シナリオの意味は変わらない

## 送信ペイロード（`op-scribe.recording/v3`）

形の唯一の定義は `shared/payload.js` の `SHAPE` です。各欄が [ADR 0003](adr/0003-privacy-guarantee-matrix.md)
の表のどの行で扱いが決まるかも、そこに書いてあります（テストで突き合わせます）。

```jsonc
{
  "schema": "op-scribe.recording/v3",
  "privacy": {
    "policy": "commercial-strict/1",
    "coverage": "commercial | standard | mixed | none",
    "hostsAliased": 1,
    "redactions": { "text": 2, "email": 1 }
  },
  "recording": {
    "id": "rec-…",
    "startedAt": "2026-10-29T01:00:00.000Z",
    "endedAt": "…",
    "startUrl": ["https://site-1.invalid/"],
    "environment": { "browser": ["Google Chrome 141"], "platform": ["macOS"], "language": ["ja"] },
    "steps": [
      { "n": 1, "type": "navigate", "t": 0, "env": "commercial", "source": "unknown", "url": ["https://site-1.invalid/"] },
      { "n": 2, "type": "input", "t": 900, "env": "commercial", "source": "user", "url": ["…"],
        "target": { "role": "textbox", "name": ["本文"], "tag": "textarea", "selector": "#body" },
        "value": { "treatment": "length", "field": "text", "kind": "text", "length": 12 } },
      { "n": 3, "type": "navigate", "t": 1200, "env": "standard", "source": "unknown",
        "url": ["https://site-2.invalid/users/", { "redacted": "id" }, "?q=", { "redacted": "v" }] },
      { "n": 4, "type": "input", "t": 1300, "env": "standard", "source": "user", "url": ["…"],
        "value": { "treatment": "kept", "field": "text", "text": ["問い合わせ ", { "redacted": "email" }] } },
      { "n": 5, "type": "tool", "t": 1500, "env": "commercial", "source": "agent", "tool": ["search_catalog"], "ok": true,
        "args": { "q": { "treatment": "length", "field": "arg", "kind": "text", "length": 5 }, "all": true } }
    ],
    "webmcpTools": [{ "site": ["https://site-1.invalid"], "tools": [["search_catalog"]] }]
  },
  "reproduction": {
    "generator": "template | on-device-ai | manual | none",
    "markdown": "…",
    "gherkin": "…"
  },
  "sentAt": "…"
}
```

- `t` は記録開始からの経過ミリ秒です。
- `type: "notice"` は、人の操作の直後にページが通知領域に出した文です。`notice`（文）と `level`（`status` / `alert`）を持ち、
  商用環境のステップにはありません。観測した事実なので、Markdown では期待結果と分けて「画面の表示」と書きます。
- `env` は、そのステップが「商用環境のホスト」での操作か（`commercial`）、それ以外か（`standard`）です。
  拡張の service worker が、Chrome が伝える送信元から判定します。`privacy.coverage` は全ステップの `env` のまとめです。
- 入力値（`value`）と WebMCP の引数の文字列・数値は、**型の付いた値**です。

  | `treatment` | 意味 | ほかの欄 |
  | --- | --- | --- |
  | `kept` | 残した（中は伏せ済み） | `text`（WebMCP の数値は `number`） |
  | `length` | 文字数だけ残した | `kind`・`length` |
  | `redacted` | 全部伏せた | `kind`（ファイルは `count` も） |

  `field` は欄の種類（`secret` `pii` `choice` `search` `text` `file` `arg`）です。
- 残した文（`kept` の `text`、名前・メモ・ツール名・環境の各欄）と URL は、**並び（runs）** です。
  ページの文字列と、伏せた箇所 `{ "redacted": 種類 }` を順に並べます。文字列の中に伏せ字を書き込むことはありません。

  | 伏せた箇所 | 現れる場所 | 描画 |
  | --- | --- | --- |
  | `secret` `card` `email` `phone` `postal` `id` `ip` `number` | 残した文 | `[[email]]` など |
  | `masked` | 残した文（登録語）、URL のパスの区切り 1 つ・クエリのキー | `[[masked]]` |
  | `id` `user` | URL のパスの区切り 1 つ | `[[id]]` `[[user]]` |
  | `v` | URL のクエリの値 | `[[v]]` |
  | `{ "redacted": "url", "as": … }` | URL 全体（並びの唯一の要素） | `[[url:invalid]]` `[[url:long]]` `[[url:none]]` `[[url:mailto]]` |

  `[[…]]` の文字列は、Gherkin に描画するときだけ作ります。Markdown では `‹メールアドレス›` のような和文の表示にします。
- `reproduction.gherkin` は、`recording` から作り直したものと一致しなければなりません。

ペイロードはフィールドを許可リスト方式で組み立てるため、タブ ID や実ホスト名との対応表、
商用環境のホストの一覧など、ブラウザ内専用の状態は構造上含まれません。出口（送信・コピー・保存）と
同梱の受信サーバは、同じ定義で形・型・扱いを検査し、合わないものを止めます。
