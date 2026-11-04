# セキュリティの報告

伏せ忘れ（個人情報や秘密が出口を通ってしまう）や、拡張・受信サーバの脆弱性を見つけたら、公開の Issue ではなく、
GitHub の **Security** タブの **Report a vulnerability** から非公開で報告してください。

- 再現の例には、架空の値（`example.com` / `*.invalid` / `*.test`、作った名前や番号）だけを使ってください。
- 実サイトの操作記録（`*.opscribe.json`）、実在の人の情報、実際のトークンは添付しないでください。
- 何を構造で保証し、何ができる限りの検出なのかは [docs/adr/0003-privacy-guarantee-matrix.md](docs/adr/0003-privacy-guarantee-matrix.md) にあります。
  表に既知の限界として書いてあるものも、実害のある例があれば報告を歓迎します。
