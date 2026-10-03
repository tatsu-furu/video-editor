# CLAUDE.md

ブラウザだけで動く初心者向け動画編集アプリ。仕様はすべて `docs/DESIGN.md` にある。作業前に必ず読むこと。

## 進め方

- 実装は設計書 13章のフェーズ（P0〜P5）の順に進める。現在は **P0 完了、次は P1**。
- 各フェーズの受け入れ基準をすべて満たしてから次へ進む。満たしたら `docs/DESIGN.md` のチェックボックスにチェックを入れる。
- 型と純粋関数（`src/core/`）を先に書き、Vitest でテストしてから、その上に UI を作る。
- 重い処理（デコード、解析、音声認識、書き出し）はメインスレッドで行わない。
- 設計書 12.5（メモリとリソース管理）と 12.6（キャンセルと後片付け）のルールは P1 から守る。
- Mediabunny、Transformers.js、onnxruntime-web、Silero VAD の API は、設計書の記述ではなく最新の公式ドキュメントで確認する。
- スコープ外の機能は実装しない。思いついたものは `docs/TODO.md` に書く。
- 設計書と異なる判断をしたら `docs/DECISIONS.md` に日付・理由とともに記録する。
- テスト用の素材はリポジトリに含めず、`scripts/make-fixtures.sh`（P1 で作成）で ffmpeg を使って `fixtures/generated/` に生成する。

## コマンド

| コマンド                                  | 内容                                    |
| ----------------------------------------- | --------------------------------------- |
| `npm run dev`                             | 開発サーバー（COOP/COEP 付き）          |
| `npm run build`                           | 型チェック＋本番ビルド（`dist/`）       |
| `npm run lint`                            | oxlint                                  |
| `npm run format` / `npm run format:check` | Prettier                                |
| `npm test`                                | Vitest（`src/**/*.test.ts`）            |
| `npm run e2e`                             | Playwright（ビルドして preview で確認） |

コミットごとに `npm run lint`、`npm run format:check`、`npm test`、`npm run build` が通ること。

## 構成

- `src/app/` 起動・機能チェック
- `src/core/` 型定義と純粋関数（DOM・React に依存しない。Worker からも import できる）
- その他のディレクトリは設計書 4章「ディレクトリ構成」に従って作る
- `netlify.toml` 本番の COOP/COEP ヘッダー。`vite.config.ts` の開発用ヘッダーと必ず揃える

## UI の言葉

UI は日本語のみ。ボタンは「何が起きるか」を動詞で書く（例：「書き出す」「字幕を入れる」）。同じ操作には最後まで同じ言葉を使う。
