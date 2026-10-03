# 動画編集アプリ（仮称）

ブラウザだけで動く、初心者向けの動画編集アプリ。動画はどこにもアップロードせず、すべての処理をブラウザ内で行う。

- 複数の動画をつないで、分割・削除・トリム・並べ替え（Undo / Redo、キーボードショートカット）
- 自動カット候補：トーク動画は無音、ゲーム録画は盛り上がりを検出して、残りを削除候補にする
- 文字起こし（ブラウザ内 Whisper）とワンボタン字幕、字幕スタイル
- BGM の挿入（ループ・フェード）、声に合わせた自動の音量調整（ダッキング）、−14 LUFS への正規化
- MP4（字幕焼き込み）/ SRT の書き出し、プロジェクトの自動保存と再開

仕様は [docs/DESIGN.md](docs/DESIGN.md)、公開手順は [docs/DEPLOY.md](docs/DEPLOY.md)、設計書と違う判断は [docs/DECISIONS.md](docs/DECISIONS.md) を参照。

## 開発

Node.js 22 以上が必要。

```bash
npm install
npm run dev
```

動作確認は最新版の Google Chrome か Microsoft Edge（パソコン版）で行う。

| コマンド           | 内容                                                    |
| ------------------ | ------------------------------------------------------- |
| `npm run dev`      | 開発サーバー（COOP/COEP 付き）                          |
| `npm run build`    | 型チェック＋本番ビルド（`dist/`）                       |
| `npm test`         | 単体テスト（Vitest）                                    |
| `npm run fixtures` | テスト用の素材を ffmpeg で `fixtures/generated/` に作る |
| `npm run e2e`      | E2E テスト（Playwright。先に `npm run fixtures`）       |

## ライセンス

未定
