# skills

ik2m の Agent Skills。Claude Code のプラグインとして入れる。

```
/plugin marketplace add ik2m/skills
/plugin install image@ik2m-skills
```

## image プラグイン

| Skill | 役割 |
| --- | --- |
| `image-maker` | HTML/CSS で画像を組み、Playwright で PNG にする。最初に載せる文章（そのまま／削るだけ可／言い換え可、視線の優先順位）を `texts.json` に決め、8 案を一覧で見せる → 選んでもらう → 8 案を作り直す、を確定までくり返す。全案を `texts.json` と突き合わせて、文章の抜けや書き換えを自動で見つける |

### 必要なもの

- Node.js と Playwright（Chromium）。Claude Code のクラウド環境には入っている
- Google Fonts に届くネットワーク（日本語フォントを読み込むため）
