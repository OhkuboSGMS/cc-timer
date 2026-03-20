#!/usr/bin/env node
/**
 * cctimer-setup - Interactive setup powered by CC agent
 *
 * 1. Ensure authentication (API key or Claude subscription)
 * 2. Launch a CC agent that:
 *    - Inspects the system (services, timers, logs, etc.)
 *    - Interviews the user about what to monitor
 *    - Generates and saves monitoring configuration via MCP tool
 */
import "dotenv/config";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig } from "./config.js";
import { StateManager } from "./state.js";
import { createInterface } from "node:readline";
import { execSync, spawnSync } from "node:child_process";

const config = loadConfig();
const state = new StateManager(config);

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

interface AuthStatus {
  loggedIn: boolean;
  authMethod: string;
  apiProvider: string;
}

function checkClaudeAuth(): AuthStatus {
  try {
    const output = execSync("claude auth status", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return JSON.parse(output);
  } catch {
    return { loggedIn: false, authMethod: "none", apiProvider: "firstParty" };
  }
}

function runClaudeLogin(): boolean {
  console.log("\nClaude Code にログインします...");
  console.log("ブラウザが開くので、アカウントで認証してください。\n");
  const result = spawnSync("claude", ["auth", "login", "--claudeai"], {
    stdio: "inherit",
  });
  return result.status === 0;
}

async function ensureAuth(): Promise<void> {
  if (config.anthropicApiKey) {
    console.log("認証: ANTHROPIC_API_KEY が設定されています。");
    return;
  }

  const auth = checkClaudeAuth();
  if (auth.loggedIn) {
    console.log(`認証: Claude Code にログイン済み (${auth.authMethod})`);
    return;
  }

  console.log("認証が必要です。以下のいずれかを選択してください:\n");
  console.log("  1. Claude サブスクリプション (Pro/Max) でログイン");
  console.log("  2. ANTHROPIC_API_KEY を .env に設定して再実行\n");

  const answer = await prompt("サブスクリプションでログインしますか? (Y/n): ");
  if (answer.toLowerCase() === "n") {
    console.error("\n.env に ANTHROPIC_API_KEY を設定してから再実行してください。");
    process.exit(1);
  }

  if (!runClaudeLogin()) {
    console.error("\nログインに失敗しました。");
    process.exit(1);
  }

  const recheck = checkClaudeAuth();
  if (!recheck.loggedIn) {
    console.error("\nログインが完了していません。");
    process.exit(1);
  }
  console.log(`\n認証完了: ${recheck.authMethod}`);
}

function buildSetupPrompt(userHint: string): string {
  return `あなたは cctimer のセットアップエージェントです。
ユーザーがこのマシンで定期監視したい内容を聞き取り、最適な監視設定を作成してください。

## ユーザーからの初期ヒント
${userHint || "（特になし）"}

## あなたのワークフロー

1. **システム調査**: まず Bash でこのマシンの状態を調べてください。
   - \`systemctl list-units --type=service --state=running --no-pager\`
   - \`systemctl list-units --type=service --state=failed --no-pager\`
   - \`systemctl list-units --type=timer --no-pager\`
   - \`df -h\` (ディスク使用量)
   - \`free -h\` (メモリ)
   - \`docker ps\` (Dockerコンテナがあれば)
   - その他、ユーザーのヒントに関連するコマンド

2. **調査結果の報告**: 見つかったサービス、タイマー、問題点をユーザーにわかりやすく報告してください。

3. **追加ヒアリング**: \`AskUserQuestion\` ツールを使って、ユーザーに質問してください。例:
   - 見つかったサービスのうち、どれを監視対象にしたいか
   - エラーと判断する基準
   - 通知の頻度や条件
   - 他に気になるものはないか

4. **設定の生成と保存**: ヒアリング結果をもとに、\`save_monitoring_config\` MCP ツールを呼んで設定を保存してください。
   - \`instructions\`: 今後の定期監視エージェントが従う詳細な手順書（日本語で）
   - \`check_targets\`: 監視対象のリスト
   - \`additional_notes\`: システム調査で気づいたことのメモ

5. **完了報告**: 保存した設定内容をユーザーに表示して完了。

## 重要
- ユーザーとの会話は日本語で行ってください。
- instructions は、別の AI エージェントが読んで正確に監視を実行できるくらい具体的に書いてください。
  コマンド例、判断基準、通知条件などを含めてください。
- 必ず \`save_monitoring_config\` を呼んで設定を保存してから終了してください。`;
}

async function setup(): Promise<void> {
  console.log("=== cctimer setup ===\n");

  await ensureAuth();

  const existingMemory = state.getMemory();
  if (existingMemory) {
    const answer = await prompt("監視設定が既に存在します。上書きしますか? (y/N): ");
    if (answer.toLowerCase() !== "y") {
      console.log("セットアップをキャンセルしました。");
      return;
    }
  }

  const userHint = await prompt(
    "何を監視したいですか？ ざっくりで OK です（例: サーバーの健全性、定期タスクの実行状況）\n> "
  );

  console.log("\nエージェントがシステムを調査して、対話的に設定を作成します...\n");

  const mcpServerPath = new URL("./mcp-server-entry.js", import.meta.url).pathname;

  try {
    for await (const message of query({
      prompt: buildSetupPrompt(userHint),
      options: {
        allowedTools: ["Bash", "Read", "Glob", "Grep", "AskUserQuestion"],
        permissionMode: "bypassPermissions",
        cwd: config.workDir || process.cwd(),
        mcpServers: {
          cctimer: {
            command: "node",
            args: [mcpServerPath],
            env: {
              ...process.env as Record<string, string>,
              CCTIMER_RUN_ID: "setup",
              CCTIMER_RUN_STARTED_AT: new Date().toISOString(),
            },
          },
        },
        canUseTool: async (toolName: string, input: any) => {
          if (toolName === "AskUserQuestion") {
            const questions: { question: string; options?: { label: string; description?: string }[] }[] = input.questions || [];
            const answers: Record<string, string> = {};

            for (const q of questions) {
              console.log(`\n${q.question}`);
              if (q.options && q.options.length > 0) {
                q.options.forEach((opt, i) => {
                  const desc = opt.description ? ` - ${opt.description}` : "";
                  console.log(`  ${i + 1}. ${opt.label}${desc}`);
                });
              }
              const answer = await prompt("> ");
              // 数字なら選択肢のラベルに変換
              const num = parseInt(answer, 10);
              if (q.options && num >= 1 && num <= q.options.length) {
                answers[q.question] = q.options[num - 1].label;
              } else {
                answers[q.question] = answer;
              }
            }

            return { behavior: "allow" as const, updatedInput: { questions, answers } };
          }
          return { behavior: "allow" as const, updatedInput: input };
        },
      },
    })) {
      if (message.type === "assistant" && message.message?.content) {
        for (const block of message.message.content) {
          if ("text" in block) {
            console.log(block.text);
          }
        }
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`\nセットアップエージェントでエラーが発生しました: ${errMsg}`);
    process.exit(1);
  }

  // 結果確認
  const savedMemory = state.getMemory();
  if (!savedMemory) {
    console.error("\n設定が保存されませんでした。再度セットアップしてください。");
    process.exit(1);
  }

  console.log("\n=== セットアップ完了 ===");
  console.log(`設定保存先: ${config.dataDir}`);

  // デーモン起動方法の選択
  console.log("\n監視デーモンの起動方法を選んでください:\n");
  console.log("  1. systemd サービスとして登録（推奨: 自動起動・自動復旧）");
  console.log("  2. このままフォアグラウンドで起動（Ctrl+C で停止）");
  console.log("  3. 後で手動で起動する\n");

  const choice = await prompt("選択 (1/2/3): ");

  switch (choice) {
    case "1": {
      await installSystemdService();
      break;
    }
    case "2": {
      console.log("\n監視デーモンを起動します... (Ctrl+C で停止)\n");
      const { daemon } = await import("./index.js");
      await daemon();
      break;
    }
    default: {
      console.log("\n後で起動するには: npm start");
      console.log("systemd 登録するには: node dist/setup.js --install-service");
      break;
    }
  }
}

async function installSystemdService(): Promise<void> {
  const { execSync: exec } = await import("node:child_process");
  const { resolve } = await import("node:path");
  const { writeFileSync } = await import("node:fs");

  const projectDir = resolve(new URL(".", import.meta.url).pathname, "..");
  const nodeExec = process.execPath;
  const entryPoint = resolve(projectDir, "dist/index.js");
  const user = process.env.USER || process.env.LOGNAME || "root";
  const envFile = resolve(projectDir, ".env");

  const serviceContent = `[Unit]
Description=cctimer - Claude Code periodic monitoring agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${projectDir}
ExecStart=${nodeExec} ${entryPoint}
Restart=on-failure
RestartSec=30
EnvironmentFile=-${envFile}

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=cctimer

[Install]
WantedBy=multi-user.target
`;

  const servicePath = "/etc/systemd/system/cctimer.service";

  console.log(`\nsystemd サービスを登録します...`);
  console.log(`  ユーザー: ${user}`);
  console.log(`  作業ディレクトリ: ${projectDir}`);
  console.log(`  実行ファイル: ${nodeExec} ${entryPoint}`);

  try {
    // sudo が必要かチェック
    const needsSudo = process.getuid?.() !== 0;
    const sudo = needsSudo ? "sudo " : "";

    // service ファイルを一時ファイルに書いてコピー
    const tmpPath = `/tmp/cctimer-${Date.now()}.service`;
    writeFileSync(tmpPath, serviceContent);

    exec(`${sudo}cp ${tmpPath} ${servicePath}`, { stdio: "inherit" });
    exec(`${sudo}systemctl daemon-reload`, { stdio: "inherit" });
    exec(`${sudo}systemctl enable cctimer`, { stdio: "inherit" });
    exec(`${sudo}systemctl start cctimer`, { stdio: "inherit" });
    exec(`rm -f ${tmpPath}`);

    console.log("\n=== systemd サービス登録完了 ===");
    console.log("  状態確認: systemctl status cctimer");
    console.log("  ログ確認: journalctl -u cctimer -f");
    console.log("  停止:     sudo systemctl stop cctimer");
    console.log("  無効化:   sudo systemctl disable cctimer");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`\nsystemd サービスの登録に失敗しました: ${errMsg}`);
    console.error("手動で登録するには: sudo deploy/install.sh");
    process.exit(1);
  }
}

setup().catch((err) => {
  console.error("Setup error:", err);
  process.exit(1);
});
