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

ステップ（ページの通知・ページからの期待結果も含む）が直前のステップと別のタブで起きたときは、その前に `When タブ N に切り替える`（`action` は `switch-tab`、`tab` は番号）が入ります。別のタブで起きた遷移は、直前の操作に起因する `Then` にはなりません。番号は記録に加わった順（1 は記録を始めたタブ）で、実タブ ID は出ません。サイドパネルで書いたメモはタブを持たないので、切り替えを起こしません。切り替えの後に来たステップは、切り替えの前の操作の結果としてまとめません。

切り替えは、ステップがどのタブで起きたかの並びから書くもので、人がタブを選んだ操作を記録したものではありません。裏のタブでページが自分で遷移したときや、裏のタブの通知が届いたときにも「タブ N に切り替える」が入ります（既知の限界）。実施記録（書式 B）の画面の移り変わりと付録、バグチケット（書式 A）の題名の画面と「画面に出た通知」は、まだタブを区別しません（#40 の残り）。ほかのタブで遷移が起きると、題名の画面がそのタブのものになったり、通知が抜けたりします。

### 属性（+α）

| 属性 | 内容 | 例 |
| --- | --- | --- |
| `action` | 操作種別 | `click` `input` `select` `check` `upload` `key` `tool` `navigate` `notice` `switch-tab` |
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
| `tab` | 切り替え先のタブの番号（`action` が `switch-tab` の行だけ）。記録に加わった順に 1 から。1 は記録を始めたタブ。切り替えの行の `source` は `unknown` | `2` |

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

## Playwright のテスト

パネルの **Playwright テストをコピー** / **保存** で、記録を `@playwright/test` のテストファイル（`rec-….spec.mjs`）にします（#2）。Gherkin と同じく記録から機械的に作り、Playwright の codegen も AI も使いません。同じ記録からは同じファイルができます。ほかの出口と同じく、構造の検査と全文の検査を通ったときだけ出ます。

```js
import { test, expect } from "@playwright/test";

test("op-scribe rec-…", async ({ page, context }) => {
  // 1. https://site-1.invalid/login を開く
  await page.goto(new URL("/login", site("OPSCRIBE_SITE_1")).href);
  // 2. 「メール」入力欄に ‹メールアドレス› を入力する
  await (await find(page, { role: "textbox", name: "メール", selector: "#email" }, 2)).fill(value("OPSCRIBE_VALUE_2", "‹メールアドレス›"));
  // 3. 「ログイン」ボタンをクリックする
  await (await find(page, { role: "button", name: "ログイン" }, 3)).click();
  // 4. https://site-1.invalid/home に遷移したことを確かめる
  await expect.poll(() => new URL(page.url()).pathname).toBe("/home");
});
```

- 要素は上の「再現する側へのルール」どおりに探す。`role` + `name`（`exact: true`）が一つに決まればそれを、決まらなければ `selector` を使い、どちらでも決まらなければ失敗する。役割と名前も selector も無いステップは `test.fixme` で止まる。
- 伏せた値は環境変数 `OPSCRIBE_VALUE_<ステップ番号>`、選んだファイルは `OPSCRIBE_FILES_<ステップ番号>`（PATH と同じ区切り）で渡す。無ければ失敗する。元の値を推測しない。
- 別名のホスト `site-N.invalid` は、`OPSCRIBE_SITE_<N>` に実際の origin（例: `https://staging.example.com`）を渡す。別名にしていないホストは記録の URL をそのまま開く。開く URL の一部が伏せてあるステップは `test.fixme` で止まる。
- 書き出した操作の直後の遷移は、パスだけを確かめる（ホストは別名のため）。WebMCP のツール呼び出しのように書き出さない操作の後の遷移は、確かめずにその URL を開く。
- 次のものはコメントにとどめ、確かめない: ページが出した通知（一時的な表示で、仕様ではなく観測）、期待結果とその判定（人が判定したもの）、探索メモ、WebMCP のツール呼び出し、人の操作として記録されていないステップ。
- 別のタブのステップの前で、そのタブに切り替える。初めて切り替えるタブは、まだ使っていないページのうち、そのステップの URL と同じパスを開いているものに決める。一つに決まらない、またはそのステップの URL が伏せてあるときは止まる。
- 複数選択のプルダウンは、記録が選んだ項目を `, ` でつないだ 1 つの文字なので、そのまま 1 つの項目として選ぼうとして失敗する（既知の限界）。
- 名前・selector・URL など記録の文字は、エスケープした文字列リテラルかコメントとしてだけ入る（改行や見えない文字はエスケープする）。出口の全文の検査は、ファイルに加えて各リテラルをエスケープ前の文字でも見る（`\` を重ねたせいで登録語が見えなくならないように）。

## 送信ペイロード（`op-scribe.recording/v5`）

拡張は v5 を作ります。受信サーバと出口の検査は、v3・v4 も受け付けます（`schema` を読み、その版の形だけで全体を検査します。古い版に新しい版の欄があれば拒否します）。

形の唯一の定義は `shared/payload.js` の `SHAPE` です。各欄が [ADR 0003](adr/0003-privacy-guarantee-matrix.md)
の表のどの行で扱いが決まるかも、そこに書いてあります（テストで突き合わせます）。

```jsonc
{
  "schema": "op-scribe.recording/v5",
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
      { "n": 1, "type": "navigate", "t": 0, "env": "commercial", "source": "unknown", "tab": 1, "url": ["https://site-1.invalid/"] },
      { "n": 2, "type": "input", "t": 900, "env": "commercial", "source": "user", "tab": 1, "url": ["…"],
        "target": { "role": "textbox", "name": ["本文"], "tag": "textarea", "selector": "#body" },
        "value": { "treatment": "length", "field": "text", "kind": "text", "length": 12 } },
      { "n": 3, "type": "navigate", "t": 1200, "env": "standard", "source": "unknown", "tab": 2,
        "url": ["https://site-2.invalid/users/", { "redacted": "id" }, "?q=", { "redacted": "v" }] },
      { "n": 4, "type": "input", "t": 1300, "env": "standard", "source": "user", "tab": 2, "url": ["…"],
        "value": { "treatment": "kept", "field": "text", "text": ["問い合わせ ", { "redacted": "email" }] } },
      { "n": 5, "type": "tool", "t": 1500, "env": "commercial", "source": "agent", "tab": 1, "tool": ["search_catalog"], "ok": true,
        "args": { "q": { "treatment": "length", "field": "arg", "kind": "text", "length": 5 }, "all": true } },
      { "n": 6, "type": "note", "t": 1800, "env": "commercial", "source": "user", "note": ["一覧が表示される"],
        "ref": "E-7f3a9k", "verdict": "ng", "actual": ["一覧が空のまま"] }
    ],
    "webmcpTools": [{ "site": ["https://site-1.invalid"], "tools": [["search_catalog"]] }],
    "scope": ["検索画面の絞り込み"],
    "targetVersion": ["2.3.0"],
    "notTested": ["決済"],
    "trimmed": "other"
  },
  "reproduction": {
    "generator": "template | on-device-ai | manual | none",
    "markdown": "…",
    "gherkin": "…"
  },
  "sentAt": "…"
}
```

- `privacy.redactions` は、記録に入れたステップと欄で伏せた回数の、種類ごとの累計です（上限などで記録しなかったステップの分は数えません）。ステップを削除しても、判定を付け直して実際の結果が消えたり置き換わったりしても減りません（今の記録に残っている伏せ字の数ではありません）。
- `t` は記録開始からの経過ミリ秒です。`endedAt` は v4 以降では `startedAt` より前になりません。
- v5 で足した欄（#40）:
  - `tab` は、そのステップが起きたタブの番号です。記録に加わった順に 1 から振り、1 は記録を始めたタブです。1 つの記録に加われるタブは、閉じたものも含めて 100 までです（`tabsJoined`）。タブを閉じても番号は変わらず、ほかのタブに振り直しません。サイドパネルで書いたメモ（`type: "note"`・`url` なし）には付きません。実タブ ID や、どのタブから開いたかは出ません。
- v4 で足した欄（[ADR 0005](adr/0005-output-formats-for-readers.md)）:
  - `ref` は、テスターが書いた期待結果（`type: "note"`・`kind` が無い・`source: "user"`）すべてに付く ID（`E-` と英小文字・数字 6 文字。拡張が乱数で振る）。ほかのステップには付きません。
  - `verdict`（`ok` / `ng`）は、テスターが付けた判定です。無ければ未判定。`actual`（実際の結果）は `ng` のステップにだけ、必ず付きます。
  - `scope`（対象と範囲）・`targetVersion`（対象のバージョン）・`notTested`（やっていないこと）は、テスターが開始時・停止時に書いた文で、無くてもよい欄です。メモと同じように伏せます。
  - `trimmed` は、上限のためにステップを保持できなかった印です。`user` は人のステップが欠けた、`other` は遷移・通知・ツール呼び出し・ページからの申告（`source` が `user` 以外）だけが欠けた、という意味です。無ければ欠けていません。
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
  | `v` | URL のクエリの値、商用環境のパスの区切り | `[[v]]` |
  | `{ "redacted": "url", "as": … }` | URL 全体（並びの唯一の要素） | `[[url:invalid]]` `[[url:long]]` `[[url:none]]` `[[url:mailto]]` |

  `[[…]]` の文字列は、Gherkin に描画するときだけ作ります。Markdown では `‹メールアドレス›` のような和文の表示にします。
- `reproduction.gherkin` は、`recording` から作り直したものと一致しなければなりません。

ペイロードはフィールドを許可リスト方式で組み立てるため、タブ ID（記録中のタブ・加わるのを待つタブの一覧を含む）や実ホスト名との対応表、
商用環境のホストの一覧など、ブラウザ内専用の状態は構造上含まれません。出口（送信・コピー・保存）と
同梱の受信サーバは、同じ定義で形・型・扱いを検査し、合わないものを止めます。
