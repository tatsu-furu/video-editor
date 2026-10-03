# 公開手順（GitHub + Netlify）

`main` ブランチに push すると、Netlify が自動でビルドして公開する。ビルド設定と COOP/COEP ヘッダーは `netlify.toml` に書いてあるので、Netlify の画面で設定する必要はない。

## 1. GitHub にリポジトリを作る

```bash
cd video-editor
git init
git add .
git commit -m "P0: 基盤"
git branch -M main
git remote add origin https://github.com/<ユーザー名>/<リポジトリ名>.git
git push -u origin main
```

公開リポジトリでも非公開リポジトリでもよい。

## 2. Netlify にサイトを作る

1. Netlify にログインし、「Add new site」→「Import an existing project」を選ぶ。
2. GitHub を選び、作ったリポジトリを選ぶ。
3. ビルド設定は `netlify.toml` から自動で入る（Build command: `npm run build`、Publish directory: `dist`）。そのまま「Deploy」。
4. 数分で `https://<サイト名>.netlify.app` に公開される。

## 3. 独自ドメインをつなぐ

既存のサイトに影響を出さないよう、サブドメイン（例：`edit.example.com`）を使うのがおすすめ。

1. Netlify のサイト設定の「Domain management」で「Add a domain」を選び、使うドメインを入力する。
2. Netlify の画面に表示される DNS の設定値を、ドメインを管理しているサービス（お名前.com、Cloudflare など）で設定する。サブドメインなら CNAME レコードを `<サイト名>.netlify.app` に向けるのが基本。
3. DNS が反映されると、HTTPS 証明書は Netlify が自動で発行する。

## 4. 公開後の確認

- 公開したページを開き、「クロスオリジン分離」が「使えます」になっていること。
- なっていない場合は、Netlify の「Deploys」→ 最新のデプロイ →「Headers」で、`Cross-Origin-Opener-Policy` と `Cross-Origin-Embedder-Policy` が付いているか確認する。

## 注意

- COEP を有効にしているため、CORS に対応していない外部の画像・フォント・埋め込みは読み込めない。外部素材は `public/` に置いて自前で配信する（設計書 3章）。
- `netlify.toml` のヘッダーを変えたら、`vite.config.ts` の開発用ヘッダーも同じにする。
