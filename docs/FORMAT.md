# 出力フォーマット

1 回の記録から 3 つの表現を作ります。中身は同じ操作列です。

| 表現 | 読み手 | 生成方法 | 編集 |
| --- | --- | --- | --- |
| 簡易手順（Markdown） | 人 | 記録から作り、Built-in AI が言い換えと概要を付ける | 可 |
| Gherkin + 属性表 | AI エージェント・自動化 | 記録から機械的に生成（AI を通さない） | 可 |
| steps（JSON） | プログラム | 記録そのもの | 不可（操作ログで削除のみ） |

## Gherkin + 属性表

通常の Gherkin（`Feature` / `Background` / `Scenario` / `Given` / `When` / `Then` / `And`）に、
**各ステップの Data Table として属性を付ける**形です。Gherkin のパーサでそのまま読め、
ステップ文だけでは失われる「どの画面の・どの要素か」を機械可読で残します。

```gherkin
# op-scribe: Gherkin + attributes
# recording: rec-example / privacy: strict
# ‹…› and [[…]] are masked values: supply test values, never guess the original.
# site-N.invalid is an alias for a host that is not disclosed.
@op-scribe @privacy-strict
Feature: 記録された操作の再現

  Background:
    Given 「Example」画面を開いている
      | url     | https://example.com/ |
      | title   | Example |
      | purpose | 検索・閲覧の画面 |
      | reason  | 検索フォーム |
      | ui      | 検索フォーム（キーワード） |
      | ui      | ナビゲーション（リンク 6 件） |

  Scenario: 記録された操作
    When 検索フォームの「キーワード」検索欄に ‹任意の文字列 5文字› を入力する
      | action    | input |
      | url       | https://example.com/ |
      | component | 検索フォーム |
      | role      | searchbox |
      | name      | キーワード |
      | tag       | input |
      | selector  | #q |
      | value     | [[text:5]] |
      | actor     | automation |
    And 検索フォームの「キーワード」検索欄で Enter キーを押す
      | action    | key |
      | url       | https://example.com/ |
      | component | 検索フォーム |
      | role      | searchbox |
      | name      | キーワード |
      | tag       | input |
      | selector  | #q |
      | key       | Enter |
      | actor     | automation |
    Then 「検索結果」画面が表示される
      | url     | https://example.com/search?q=[[v]] |
      | title   | 検索結果 |
      | purpose | 検索・一覧の閲覧の画面 |
      | reason  | URL（/search） |
      | reason  | 同じ形のリンクが 20 件 |
      | ui      | 一覧（同じ形のリンク 20 件） |
      | ui      | ボタン（並び替え、絞り込み） |
    When 一覧（20 件）の「ある記事」リンクをクリックする
      | action    | click |
      | url       | https://example.com/search?q=[[v]] |
      | component | 一覧（20 件） |
      | role      | link |
      | name      | ある記事 |
      | tag       | a |
      | selector  | main > a:nth-of-type(1) |
      | href      | https://example.com/n/:id |
      | actor     | automation |
    Then 「ある記事」画面が表示される
      | url     | https://example.com/n/:id |
      | title   | ある記事 |
      | purpose | 詳細の閲覧の画面 |
      | reason  | 記事本文 |
      | ui      | 本文（約 4200 文字） |
      | ui      | ボタン（スキ、フォロー、共有） |
```

### キーワードの割り当て

| キーワード | 何を表すか |
| --- | --- |
| `Given`（Background） | 記録開始時の画面（画面の属性表つき） |
| `When` | 操作 1 つ（人・自動テスト・スクリプト・エージェントのいずれでも） |
| `Then` | 操作の結果表示された画面（画面の属性表つき）、操作ログに追加した期待結果・確認点 |
| `And` | 直前と同じ種類が続くとき |

操作に起因しない遷移（アドレスバーへの直接入力など）は `When "…" を開く` になります。

### 画面の属性（`Given` / `Then … 画面が表示される` の表）

| 属性 | 内容 | 例 |
| --- | --- | --- |
| `url` | 画面の URL（伏せ済み） | `https://example.com/trend` |
| `title` | `head > title`（伏せ済み） | `急上昇` |
| `h1` | 主見出し（title と違うときだけ） | |
| `purpose` | 推定した画面の目的 | `一覧の閲覧の画面`、`検索・一覧の閲覧の画面` |
| `reason` | 推定の根拠（複数行） | `検索フォーム`、`同じ形のリンクが 32 件`、`URL（/search）` |
| `ui` | 主な UI（複数行） | `検索フォーム（キーワード）`、`入力フォーム（3 項目: 氏名、メール、件名） → 「送信」` |

目的は、検索・作成・投稿・編集・保存・削除・ログイン・購入・出力・共有・反応・情報の入力・一覧の閲覧・詳細の閲覧から推定します（`shared/screen.js`）。

### 操作の属性（+α）

| 属性 | 内容 | 例 |
| --- | --- | --- |
| `action` | 操作種別 | `click` `input` `select` `check` `upload` `key` `submit` `tool` `navigate` |
| `url` | 操作した画面の URL（伏せ済み） | `https://site-1.invalid/orders/:id` |
| `role` | 対象要素の ARIA ロール（明示 or 暗黙） | `button` `link` `textbox` `combobox` |
| `name` | 対象要素のアクセシブルネーム（伏せ済み・厳格モードは 40 字まで） | `ログインする` |
| `tag` | HTML タグ名 | `button` |
| `selector` | 再特定用の CSS セレクタ。`data-testid` 等 → 安定した `id` → 4 階層までのパスの順で選ぶ。伏せる必要があった場合は出さない | `[data-testid="save"]` |
| `href` | リンク先（伏せ済み） | |
| `value` | 入力値（伏せ字のまま） | `[[text:12]]` `[[email]]` |
| `checked` | チェック操作後の状態 | `true` |
| `key` | 押したキー | `Enter` `meta+Enter` `Escape` |
| `tool` / `args` | 実行された WebMCP ツール名と引数（伏せ済み） | `search_catalog` / `{"q":"[[text:5]]"}` |
| `component` | 操作した部品 | `ヘッダー`、`検索フォーム`、`一覧（32 件）`、`ダイアログ「確認」` |
| `intent` | ボタン等の表示名から読んだ意図 | `編集・保存`、`削除` |
| `actor` | 人以外が操作したとき: `automation`（WebDriver / CDP）、`script`（ページ内スクリプト）、`agent`（WebMCP） | |
| `source` | エージェントが追記した期待結果のとき `agent` | |

再現する側（人・AI）へのルール:

- 要素は `role` + `name` で探し、見つからなければ `selector` を使う（Playwright の `getByRole` に対応）。
- `[[…]]` / `‹…›` は伏せた値。元の値を推測せず、テスト用の値を用意して入れる。`[[text:N]]` は N 文字程度の任意文字列。
- `site-N.invalid` は伏せたホストの別名。実ホストは記録した人に確認する。

## 簡易手順（Markdown）

```markdown
# 「Example」から「ある記事」までの操作（4 ステップ）

## 前提条件
- https://example.com にアクセスできる状態であること

## 手順

### 画面 1: 「Example」
- URL: https://example.com/
- 画面の目的: 検索・閲覧の画面（根拠: 検索フォーム）
- 主な UI: 検索フォーム（キーワード） / ナビゲーション（リンク 6 件）

1. https://example.com/ を開く
2. 検索フォームの「キーワード」検索欄に ‹任意の文字列 5文字› を入力する
3. 検索フォームの「キーワード」検索欄で Enter キーを押す
   - 期待結果: 「検索結果」画面に遷移する

### 画面 2: 「検索結果」
- URL: https://example.com/search?q=[[v]]
- 画面の目的: 検索・一覧の閲覧の画面（根拠: URL（/search）、同じ形のリンクが 20 件）
- 主な UI: 一覧（同じ形のリンク 20 件） / ボタン（並び替え、絞り込み）

4. 一覧（20 件）の「ある記事」リンクをクリックする
   - 期待結果: 「ある記事」画面に遷移する

## 補足
- ‹任意の文字列 N文字› は記録時の入力を伏せたもの。再現時は同じ程度の長さの値を使う
- 操作の主体: 自動テスト 3 件
```

## 送信ペイロード（`op-scribe.recording/v1`）

```jsonc
{
  "schema": "op-scribe.recording/v1",
  "recording": {
    "id": "rec-…",
    "startedAt": "2026-10-29T01:00:00.000Z",
    "endedAt": "…",
    "startUrl": "https://site-1.invalid/",
    "privacy": { "level": "strict", "hostsAliased": 1, "redactions": { "text": 2, "email": 1 } },
    "environment": { "browser": "Google Chrome 141", "platform": "macOS", "language": "ja" },
    "steps": [
      { "n": 1, "type": "navigate", "t": 0, "url": "https://site-1.invalid/", "source": "user" },
      { "n": 2, "type": "click", "t": 900, "url": "…", "source": "user",
        "target": { "role": "link", "name": "ログイン", "tag": "a", "selector": "…", "href": "…" } }
    ],
    "webmcpTools": [{ "site": "https://site-1.invalid", "tools": ["search_catalog"] }]
  },
  "reproduction": {
    "generator": "built-in-ai | template | manual | none",
    "markdown": "…",
    "gherkin": "…"
  },
  "sentAt": "…"
}
```

`t` は記録開始からの経過ミリ秒です。ペイロードはフィールドを許可リスト方式で組み立てるため、
タブ ID や実ホスト名との対応表など、ブラウザ内専用の状態は構造上含まれません。
