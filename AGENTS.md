# AGENTS.md

AI エージェント向けの作業ルール。人向けの説明は README.md。

## 最優先: このリポジトリは公開される

- 社名・部署名・製品コードネーム・実在の人名・社内ホスト名/URL・社用メールアドレスを、コード・テスト・
  ドキュメント・コミットメッセージ・PR 本文のどこにも書かない。
- 例示には `example.com` / `*.invalid` / `*.test`、架空の値だけを使う。
- secret 形式の文字列（API キー・トークン）はテスト内で連結して組み立て、完成形をファイルに残さない。
- 隠したい語を denylist としてリポジトリ内に列挙しない。`scripts/pii-guard.patterns.local.txt`（gitignore）にだけ書く。
- 実サイトの操作記録（`*.opscribe.json`、`recordings/`）はコミットしない。
- コミットの identity は `users.noreply.github.com` のみ。
- AI ツールの共著者行（`Co-Authored-By: … <noreply@anthropic.com>`）は author / committer の identity ではなく、固定の noreply アドレスなので、
  社名・製品名・社用メールの禁止の対象外とする（オーナー判断）。

## 設計上の不変条件（壊さないこと）

- 入力値は `content/recorder.js` 内で `maskFieldValue` を通してから拡張へ渡す（生の値をページ外に出さない）。
- service worker は届いたステップを必ず `cleanStep` で再サニタイズする。
- 送信ペイロードの形は `shared/payload.js` の `SHAPE` だけで定義し、`buildPayload` はその許可リストで組み立てる。ブラウザ内専用の状態（タブ ID、実ホスト対応表、商用ホストの一覧）を足さない。欄を足すときは、先に `docs/adr/0003` の表に行を足す。
- 送信・コピー・保存のすべての出口と受信サーバで、`checkPayload`（構造の検査）と `finalScan`（できる限りの検出）の両方を通し、どちらかで検出があれば止める。`checkPayload` は `shared/sanitize.js` を使わない。
- 入力値と WebMCP の引数は型の付いた値（`{ treatment, field, … }`）で持つ。残した文と URL は、ページの文字列と伏せた箇所の並び（runs）で持ち、文字列に伏せ字を書き込まない。並びの伏せ字の書き方は `shared/limits.js` の `renderRuns`、型の付いた値の伏せ字の書き方は `shared/describe.js` の `display` だけで定義し、`[[…]]` を出力に描くのは `shared/describe.js` だけ（オーナー判断 2026-11-01）。
- Gherkin は記録から決定的に生成する。AI の出力から作らない。
- オンデバイス AI の出力は `validate` を通らなければ採用しない。

フィルタを変えたら `tests/sanitize.test.mjs`（worker 側は `tests/record.test.mjs`、送信データは `tests/payload.test.mjs`）にケースを足し、`pnpm test` と `pnpm guard` を通すこと。
