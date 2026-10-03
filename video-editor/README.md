# 動画編集アプリ（仮称）

ブラウザだけで動く、初心者向けの動画編集アプリ。動画はどこにもアップロードせず、すべての処理をブラウザ内で行う。

- 自動カット（無音・盛り上がりの検出）
- 文字起こしとワンボタン字幕
- BGM の挿入と、声に合わせた自動の音量調整
- MP4 / SRT の書き出し

仕様は [docs/DESIGN.md](docs/DESIGN.md)、公開手順は [docs/DEPLOY.md](docs/DEPLOY.md) を参照。

## 開発

Node.js 22 以上が必要。

```bash
npm install
npm run dev
```

動作確認は最新版の Google Chrome か Microsoft Edge（パソコン版）で行う。

## ライセンス

未定
