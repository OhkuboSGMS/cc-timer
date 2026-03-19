# cctimer

Claude Code Agent SDK を使った定期監視デーモン。CC エージェントが自分で次回実行間隔を決める。

## 仕組み

1. デーモンがスケジュールに従って CC エージェントを起動
2. エージェントが MCP ツール経由でシステムを監視
3. 結果に応じて通知を送信し、次回実行間隔を自己決定
4. 異常時は短い間隔、正常時は長い間隔で自動調整

## アーキテクチャ

```
daemon (index.ts)
  └─ Agent SDK で CC を起動 (agent.ts)
       └─ MCP Server (mcp-server.ts) を子プロセスで起動
            ├─ schedule_next_run    … 次回実行時刻を設定
            ├─ send_notification    … Webhook で通知送信
            ├─ get_run_history      … 過去の監視結果を取得
            ├─ get_monitoring_config … 監視設定を取得
            ├─ update_monitoring_notes … メモを追加
            └─ record_run_result   … 実行結果を記録
```

状態は `~/.cctimer/` に JSON ファイルとして永続化される。

## セットアップ

```bash
npm install
npm run build

# .env を設定
cp .env.example .env
# ANTHROPIC_API_KEY を記入

# 対話的に監視対象を設定
npm run setup

# デーモン起動
npm start
```

## systemd でデーモン化

```bash
sudo deploy/install.sh
sudo systemctl start cctimer
sudo systemctl enable cctimer
journalctl -u cctimer -f
```

## 環境変数

| 変数 | 説明 | デフォルト |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API キー (必須) | - |
| `CCTIMER_WEBHOOK_URL` | 通知先 Webhook URL | - |
| `CCTIMER_DATA_DIR` | 状態ファイル保存先 | `~/.cctimer` |
| `CCTIMER_WORK_DIR` | エージェントの作業ディレクトリ | カレントディレクトリ |
| `CCTIMER_DEFAULT_INTERVAL_MIN` | デフォルト間隔 (分) | 30 |
| `CCTIMER_MAX_INTERVAL_MIN` | 最大間隔 (分) | 1440 |
| `CCTIMER_MIN_INTERVAL_MIN` | 最小間隔 (分) | 5 |
