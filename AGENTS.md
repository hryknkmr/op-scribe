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
- AI ツールの共著者行（`Co-Authored-By: … <noreply@anthropic.com>`）は固定の noreply アドレスで、社名・社用メールの禁止の
  対象外とする（オーナー判断）。`scripts/pii-guard.sh` はこのアドレスだけを完全一致で許可する。

## 設計上の不変条件（壊さないこと）

- 入力値は `content/recorder.js` 内で `maskFieldValue` を通してから拡張へ渡す（生の値をページ外に出さない）。
- service worker は届いたステップを必ず `cleanStep` で再サニタイズする。
- 送信ペイロードは `buildPayload` の許可リストで組み立てる。ブラウザ内専用の状態（タブ ID、実ホスト対応表）を足さない。
- 送信・コピー・保存のすべての出口で `finalScan` を通し、検出があれば止める。
- Gherkin は記録から決定的に生成する。AI の出力から作らない。
- オンデバイス AI の出力は `validate` を通らなければ採用しない。
- 画面の構造（`extractScreen` → `classifyScreen`）には UI のラベルと件数・文字数だけを入れる。一覧・カード・記事・エディタの中身は入れない。

フィルタを変えたら `tests/sanitize.test.mjs` にケースを足し、`pnpm test` と `pnpm guard` を通すこと。
