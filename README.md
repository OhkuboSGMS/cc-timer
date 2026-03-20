# cc-timer

[![CI](https://github.com/OhkuboSGMS/cc-timer/actions/workflows/ci.yml/badge.svg)](https://github.com/OhkuboSGMS/cc-timer/actions/workflows/ci.yml)

Claude Code Agent SDK を使った定期監視デーモン。CC エージェントが自分で次回実行間隔を決める。

**対応 OS**: Linux / macOS / Windows

## 仕組み

1. デーモンがスケジュールに従って CC エージェントを起動
2. エージェントが MCP ツール経由でシステムを監視
3. 結果に応じて通知を送信（Discord Webhook 対応）し、次回実行間隔を自己決定
4. 異常時は短い間隔、正常時は長い間隔で自動調整

## アーキテクチャ

```
setup (setup.ts)
  ├─ 認証 (API キー or Claude サブスクリプション)
  ├─ Agent SDK でヒアリングエージェントを起動
  │    ├─ OS に応じたシステム調査
  │    │    ├─ Linux:   systemctl, journalctl, df, free
  │    │    ├─ macOS:   launchctl, df, vm_stat, brew services
  │    │    └─ Windows: Get-Service, Get-PSDrive (PowerShell)
  │    ├─ AskUserQuestion でユーザーに対話的質問
  │    └─ save_monitoring_config で設定を保存
  └─ OS に応じたサービス登録
       ├─ Linux:   systemd
       ├─ macOS:   launchd
       └─ Windows: タスクスケジューラ

daemon (index.ts)
  └─ Agent SDK で CC を起動 (agent.ts)
       └─ MCP Server (mcp-server.ts) を子プロセスで起動
            ├─ schedule_next_run       … 次回実行時刻を設定
            ├─ send_notification       … Webhook で通知送信
            ├─ get_run_history         … 過去の監視結果を取得
            ├─ get_monitoring_config   … 監視設定を取得
            ├─ update_monitoring_notes … メモを追加
            ├─ record_run_result       … 実行結果を記録
            └─ save_monitoring_config  … 監視設定を保存（setup 時）
```

## セットアップ

### 前提条件

- Node.js 22+
- 以下のいずれか:
  - Claude サブスクリプション (Pro/Max) — API キー不要
  - Anthropic API キー (`ANTHROPIC_API_KEY`)

### インストールと初期設定

```bash
npm install
npm run build
npm run setup
```

`npm run setup` は対話的に以下を行う:

1. **認証**: API キーがなければ Claude サブスクリプションでログイン
2. **ヒアリング**: ざっくり監視したいことを入力
3. **システム調査**: エージェントがマシンの状態を自動調査
4. **追加質問**: エージェントがユーザーに詳細を質問
5. **設定生成**: 調査とヒアリング結果から監視設定を自動作成・保存
6. **起動方法選択**:
   - サービスとして登録（推奨 — OS に応じて自動選択）
   - フォアグラウンドで起動
   - 後で手動起動

## データ保存先

状態は `~/.cctimer/` に保存される。

| ファイル | 内容 |
|---|---|
| `memory.json` | 監視設定（ターゲット、指示、エージェントが追記したメモ） |
| `history.json` | 実行履歴（各回のサマリー、問題の有無、タイムスタンプ） |
| `schedule.json` | 次回実行時刻 |
| `runs/{runId}.log` | 各ランの詳細ログ（エージェントの発言、ツール呼び出し） |

## サービス管理

setup でサービス登録した場合、OS に応じたコマンドで管理する。

### Linux (systemd)

```bash
systemctl status cctimer         # 状態確認
journalctl -u cctimer -f         # ログ
sudo systemctl restart cctimer   # 再起動
sudo systemctl stop cctimer      # 停止
sudo systemctl disable cctimer   # 自動起動解除
```

### macOS (launchd)

```bash
launchctl list | grep cctimer                                    # 状態確認
tail -f ~/Library/Logs/cctimer/cctimer.stdout.log                # ログ
launchctl unload ~/Library/LaunchAgents/com.cctimer.agent.plist  # 停止
```

### Windows (タスクスケジューラ)

```powershell
schtasks /Query /TN "cctimer"          # 状態確認
schtasks /End /TN "cctimer"            # 停止
schtasks /Delete /TN "cctimer" /F      # 削除
```

### 手動起動

```bash
npm start  # フォアグラウンドで実行 (Ctrl+C で停止)
```

## 環境変数

| 変数 | 説明 | デフォルト |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API キー（サブスクリプション認証時は不要） | - |
| `CCTIMER_WEBHOOK_URL` | 通知先 Webhook URL（Discord 対応） | - |
| `CCTIMER_DATA_DIR` | 状態ファイル保存先 | `~/.cctimer` |
| `CCTIMER_WORK_DIR` | エージェントの作業ディレクトリ | カレントディレクトリ |
| `CCTIMER_DEFAULT_INTERVAL_MIN` | デフォルト間隔 (分) | 30 |
| `CCTIMER_MAX_INTERVAL_MIN` | 最大間隔 (分) | 1440 |
| `CCTIMER_MIN_INTERVAL_MIN` | 最小間隔 (分) | 5 |

## 通知

Webhook URL に応じて自動でフォーマットを切り替える:

- **Discord**: embed 形式（severity に応じて色分け: 青=info, オレンジ=warning, 赤=critical）
- **その他**: 汎用 JSON ペイロード
