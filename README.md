# op-scribe

Chrome でのブラウザ操作を記録し、**個人情報・社内情報を伏せたうえで**、次の形に整理する Manifest V3 拡張です。

- **簡易手順（自然言語）**: 人が読む再現手順。オンデバイス AI（Gemini Nano / Prompt API）で整形、使えなければテンプレート
- **Gherkin + 属性表**: AI・自動化が再現しやすい Feature ファイル。各ステップに画面 URL・対象要素（role / name / selector）などを Data Table で付与
- **操作記録データ（JSON）**: 上の 2 つと全ステップを含むペイロード。プレビューを確認してから任意の送信先へ POST

WebMCP にも対応しています。記録中のページには `opscribe_*` ツールを登録し、エージェントがそのサイトでの
手順を取得したり期待結果を書き足したりできます。また、エージェントがページ側の WebMCP ツールを呼んだ操作も
人の操作と並べて記録します。

フォーマットの詳細は [docs/FORMAT.md](docs/FORMAT.md)、何を伏せて何を残すかは [docs/PRIVACY.md](docs/PRIVACY.md) を参照してください。

## 必要なもの

- Chrome 138 以降（Prompt API が拡張で使える版）
- オンデバイス AI を使う場合: Gemini Nano が利用可能な端末。使えない場合もテンプレートで動きます
- WebMCP 連携を使う場合: `--enable-features=WebMCP,WebMCPTesting` 付きで起動した Chrome（Canary）。
  無効でも記録・手順化・送信は動きます

## インストール（開発版）

1. `chrome://extensions` → デベロッパーモード → 「パッケージ化されていない拡張機能を読み込む」→ このディレクトリ
2. ツールバーのアイコンで Side Panel を開く

インストール時点ではどのサイトにもアクセスできません。記録開始時に、そのタブのサイトだけ許可を求めます。

## 使い方

1. 記録したいページで Side Panel の **記録開始** → サイトへのアクセスを許可
2. 普段どおり操作する。別サイトへ移ったら「このサイトも記録する」で追加許可
3. 必要なら **操作ログ** に期待結果・確認点を追記（Gherkin では `Then` になる）、不要なステップは × で削除
4. **停止** → **再現手順** で「AI で整理」または「テンプレートで生成」
5. **出力・送信** で Markdown / Gherkin をコピー、JSON を保存、またはプレビューして送信

送信先は「プライバシーと送信先」で設定します（https、または http://localhost のみ）。
設定・記録はブラウザ内にだけ保存され、記録はブラウザを閉じると消えます。

### 送信の動作確認

```bash
pnpm receiver            # http://localhost:8787/recordings で待ち受け、recordings/ に保存
```

送信先に `http://localhost:8787/recordings` を設定して送信します。受信側でも伏せ忘れを検査し、
見つかれば 422 で拒否します。

## プライバシーの既定値

- 入力値は**厳格モード**: パスワード・メール・電話などは種類だけ、その他の自由入力は文字数だけを残す
- 許可リストに無いホスト名は `site-1.invalid` のような別名にする
- 「必ず伏せる語」（社名・製品名・人名など）を設定画面で登録できる
- 送信・コピー・保存の直前に全文を再検査し、1 件でも残っていれば中止する

## 開発

```bash
pnpm setup-hooks   # commit / push 時の PII ガードと unit test を有効化（clone 後に必ず実行）
pnpm test          # プライバシーフィルタと手順生成の unit test
pnpm guard         # tracked ファイル全体を PII / secret ガードで走査
pnpm pack          # dist/ に配布用 zip（拡張に必要なファイルだけ）
```

外部依存はありません（ビルド不要・素の JavaScript）。

### 公開リポジトリとしての注意

このリポジトリは公開を前提にしています。clone したら、社名・社内ホスト名・自分の実名などを
`scripts/pii-guard.patterns.local.txt`（gitignore 済み）に書いてください。書き方は
[`scripts/pii-guard.patterns.local.example.txt`](scripts/pii-guard.patterns.local.example.txt) にあります。
これらの語をリポジトリ内のファイル（denylist を含む）に書いてはいけません。詳しくは [docs/PRIVACY.md](docs/PRIVACY.md)。

テスト・ドキュメントの例には `example.com` / `*.invalid` / `*.test` だけを使います。

## 構成

| パス | 役割 |
| --- | --- |
| `shared/sanitize.js` | プライバシーフィルタ（全コンテキスト共通）。入力欄の分類、パターン検出、URL の別名化、最終検査 |
| `shared/describe.js` | 手順化（自然言語・Gherkin）とペイロード組み立て |
| `content/recorder.js` | ページ内で操作を拾う（ISOLATED world）。入力値はここで伏せる |
| `content/webmcp-tools.js` | WebMCP ツールの登録とページ側ツール呼び出しの記録（MAIN world） |
| `service-worker.js` | 記録状態の管理、二重サニタイズ、WebMCP 要求への応答 |
| `sidepanel/` | 操作 UI、オンデバイス AI での整形、プレビュー・送信 |
| `tools/receiver.mjs` | 動作確認用のローカル受信サーバ |
| `scripts/pii-guard.sh` | commit / push / CI 共通の PII・secret ガード |
