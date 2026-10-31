# 出力フォーマット

1 回の記録から 3 つの表現を作ります。中身は同じ操作列です。

| 表現 | 読み手 | 生成方法 | 編集 |
| --- | --- | --- | --- |
| 簡易手順（Markdown） | 人 | テンプレート、またはオンデバイス AI で整形 | 可 |
| Gherkin + 属性表 | AI エージェント・自動化 | 記録から機械的に生成（AI を通さない） | 可 |
| steps（JSON） | プログラム | 記録そのもの | 不可（操作ログで削除のみ） |

## Gherkin + 属性表

通常の Gherkin（`Feature` / `Background` / `Scenario` / `Given` / `When` / `Then` / `And`）に、
**各ステップの Data Table として属性を付ける**形です。Gherkin のパーサでそのまま読め、
ステップ文だけでは失われる「どの画面の・どの要素か」を機械可読で残します。

```gherkin
# op-scribe: Gherkin + attributes
# recording: rec-mgx0abcd-1a2b3c / privacy: tiered-commercial/v1
# ‹…› and [[…]] are masked values, and so are values with * (t***@e***.com, 12****78): supply test values, never guess the original.
# site-N.invalid is an alias for a host that is not disclosed.
@op-scribe @privacy-tiered-commercial
Feature: 記録された操作の再現

  Background:
    Given "https://site-1.invalid/" を開いている
      | url | https://site-1.invalid/ |

  Scenario: 記録された操作
    When 「ログイン」リンクをクリックする
      | action   | click |
      | url      | https://site-1.invalid/ |
      | role     | link |
      | name     | ログイン |
      | tag      | a |
      | selector | [data-testid="login-link"] |
      | href     | https://site-1.invalid/login |
    Then "https://site-1.invalid/login" に遷移する
      | url | https://site-1.invalid/login |
    When 「メールアドレス」入力欄に 「t***@e***.com」 を入力する
      | action   | input |
      | url      | https://site-1.invalid/login |
      | role     | textbox |
      | name     | メールアドレス |
      | selector | #email |
      | value    | t***@e***.com |
    And 「ログインする」ボタンをクリックする
      | action   | click |
      | url      | https://site-1.invalid/login |
      | role     | button |
      | name     | ログインする |
      | selector | form > button |
    Then "https://site-1.invalid/home" に遷移する
      | url | https://site-1.invalid/home |
    And ホーム画面にユーザーメニューが表示される
```

### キーワードの割り当て

| キーワード | 何を表すか |
| --- | --- |
| `Given`（Background） | 記録開始時の画面 |
| `When` | ユーザー（または agent）の操作 1 つ |
| `Then` | 操作の直後 4 秒以内に起きた画面遷移、操作ログに追加した期待結果・確認点 |
| `And` | 直前と同じ種類が続くとき |

操作に起因しない遷移（アドレスバーへの直接入力など）は `When "…" を開く` になります。

### 属性（+α）

| 属性 | 内容 | 例 |
| --- | --- | --- |
| `action` | 操作種別 | `click` `input` `select` `check` `upload` `key` `submit` `tool` `navigate` |
| `url` | 操作した画面の URL（伏せ済み） | `https://site-1.invalid/orders/:id` |
| `role` | 対象要素の ARIA ロール（明示 or 暗黙） | `button` `link` `textbox` `combobox` |
| `name` | 対象要素のアクセシブルネーム（伏せ済み・80 字まで） | `ログインする` |
| `tag` | HTML タグ名 | `button` |
| `selector` | 再特定用の CSS セレクタ。`data-testid` 等 → 安定した `id` → 4 階層までのパスの順で選ぶ。伏せる必要があった場合は出さない | `[data-testid="save"]` |
| `href` | リンク先（伏せ済み） | |
| `value` | 入力値（方針どおり伏せたもの） | `週末 レシピ` `s***@e***.com` `[[secret]]` |
| `checked` | チェック操作後の状態 | `true` |
| `key` | 押したキー | `Enter` `meta+Enter` `Escape` |
| `tool` / `args` | 実行された WebMCP ツール名と引数（伏せ済み） | `search_catalog` / `{"q":"shoes"}` |
| `source` | agent による操作・追記のとき `agent` | |

再現する側（人・AI）へのルール:

- 要素は `role` + `name` で探し、見つからなければ `selector` を使う（Playwright の `getByRole` に対応）。
- `[[…]]` / `‹…›` は伏せた値。元の値を推測せず、テスト用の値を用意して入れる。
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

## 送信ペイロード（`op-scribe.recording/v2`）

```jsonc
{
  "schema": "op-scribe.recording/v2",
  "recording": {
    "id": "rec-…",
    "startedAt": "2026-10-29T01:00:00.000Z",
    "endedAt": "…",
    "startUrl": "https://site-1.invalid/",
    "privacy": {
      "policy": "tiered-commercial/v1",
      "coverage": "mixed",              // commercial-only | standard-only | mixed
      "commercialSteps": 1, "standardSteps": 2,
      "hostsAliased": 1, "redactions": { "secret": 1, "text": 1 }
    },
    "environment": { "browser": "Google Chrome 141", "platform": "macOS", "language": "ja" },
    "steps": [
      { "n": 1, "type": "navigate", "t": 0, "url": "https://site-1.invalid/", "source": "user",
        "privacy": { "profile": "standard" } },
      { "n": 2, "type": "click", "t": 900, "url": "…", "source": "user", "privacy": { "profile": "standard" },
        "target": { "role": "link", "name": "ログイン", "tag": "a", "selector": "…", "href": "…" } },
      { "n": 3, "type": "input", "t": 2100, "url": "https://site-2.invalid/contact", "source": "user",
        "value": "[[text:12]]", "valueClass": "text", "privacy": { "profile": "commercial" } }
    ],
    "webmcpTools": [{ "site": "https://site-1.invalid", "tools": ["search_catalog"] }]
  },
  "reproduction": {
    "generator": "template | on-device-ai | manual | none",
    "markdown": "…",
    "gherkin": "…"
  },
  "sentAt": "…"
}
```

伏せ方は `privacy.policy`（`tiered-commercial/v1`）とステップごとの `privacy.profile` で表します（[ADR 0001](adr/0001-commercial-environment-policy.md)、[PRIVACY.md](PRIVACY.md)）。

- `commercial`: 商用環境として登録したホストでの操作。自由入力は文字数だけ（`[[text:12]]`）、検索欄（`valueClass: search`）と選択肢（`choice`）の値は残す。URL の値は短い英数字だけ
- `standard`: それ以外（beta・staging など）。入力と URL の値は残し、認証情報は完全に、メール・電話・ID は一部だけ伏せる
- どちらでも、`[[…]]` と `*` を含む値は伏せた値です。受け取る側は、`standard` のステップの値を「文字数だけ」と見なさないでください
- 商用のステップを含む記録の `gherkin` は、手の編集を使わず記録から作り直したものです
- 受信側は、知らない `schema` や `privacy.policy` を拒否してください（同梱の受信サーバはそうしています）

`t` は記録開始からの経過ミリ秒です。ペイロードはフィールドを許可リスト方式で組み立てるため、
タブ ID や実ホスト名との対応表など、ブラウザ内専用の状態は構造上含まれません。
