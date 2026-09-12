# MUSK RADAR — イーロン・マスク動向レーダー

**https://musk.toriumis.com/**

イーロン・マスクの動向（発言・YouTube出演・SpaceX・Tesla・xAI・教育）を、日本語のニュースとしてリアルタイムに追跡するサイト。Cloudflare Worker上で動作し、**アクセスのたびに** Google News RSS（日本語）を複数クエリで取得・マージ・重複排除してSSR配信する。サーバー管理もGitHub Actionsも不要で、常に最新。

## 仕組み

```
訪問者 → Cloudflare Worker (musk-radar)
            ├─ Google News RSS × 7クエリ（総合/YouTube/発言/SpaceX/Tesla/xAI/教育）を並列取得
            ├─ タイトル正規化で重複排除 + キーワードでカテゴリ自動付与
            ├─ 10分間のメモリキャッシュ
            └─ 日本語HTMLをSSR配信（10分ごと自動再読み込み）
```

- **ページ**: カテゴリチップ（YouTube / 発言 / SpaceX / Tesla / xAI・AI / 教育）+ キーワード絞り込み
- **API**: `/api/news`（JSON, CORS許可）, `?cat=youtube` `?limit=20` 等のパラメータ対応
  - 姉妹サイト [HUMAN OS（教育）](https://github.com/toriumib/human-os) は `?cat=edu` を教育ニュースとして埋め込み利用

## 運用

```bash
npx wrangler deploy   # デプロイ（更新時のみ。ニュースの更新は自動）
```

ニュースデータはリポジトリに保存しない（常時ライブ取得）ため、放置しても最新であり続ける。

## カテゴリとクエリ

| カテゴリ | Google News クエリ（hl=ja / gl=JP） |
|---|---|
| 総合 | イーロン・マスク OR イーロンマスク OR Elon Musk |
| YouTube | イーロン・マスク YouTube OR ユーチューブ |
| 発言 | イーロン・マスク 発言 OR 発信 |
| SpaceX | スペースX OR スターシップ OR スターリンク |
| Tesla | テスラ マスク |
| xAI・AI | Grok OR xAI |
| 教育 | マスク 学校 OR Astra Nova OR Ad Astra |

## ライセンス

MIT — 記事の権利は各掲載メディアに帰属します。
