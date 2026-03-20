#!/usr/bin/env node
/**
 * cctimer-setup - Interactive setup powered by CC agent
 *
 * 1. Ensure authentication (API key or Claude subscription)
 * 2. Launch a CC agent that:
 *    - Inspects the system (services, timers, logs, etc.)
 *    - Interviews the user about what to monitor
 *    - Generates and saves monitoring configuration via MCP tool
 * 3. Register as a system service or run in foreground
 */
import "dotenv/config";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig } from "./config.js";
import { StateManager } from "./state.js";
import { getDirname } from "./paths.js";
import { createInterface } from "node:readline";
import { execSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { userInfo, homedir } from "node:os";

const __dirname = getDirname(import.meta.url);
const config = loadConfig();
const state = new StateManager(config);

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(question, (answer) => {
      rl.close();
      res(answer.trim());
    });
  });
}

// --- Authentication ---

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

// --- OS-aware setup prompt ---

function getSystemInvestigationHint(): string {
  const platform = process.platform;

  if (platform === "linux") {
    return `このシステムは Linux です。以下のコマンドで調査を開始してください:
   - \`systemctl list-units --type=service --state=running --no-pager\`
   - \`systemctl list-units --type=service --state=failed --no-pager\`
   - \`systemctl list-units --type=timer --no-pager\`
   - \`df -h\` (ディスク使用量)
   - \`free -h\` (メモリ)
   - \`docker ps\` (Dockerコンテナがあれば)`;
  }

  if (platform === "darwin") {
    return `このシステムは macOS です。以下のコマンドで調査を開始してください:
   - \`launchctl list\` (起動中のサービス)
   - \`df -h\` (ディスク使用量)
   - \`vm_stat\` (メモリ状態)
   - \`docker ps\` (Dockerコンテナがあれば)
   - \`brew services list\` (Homebrew サービスがあれば)`;
  }

  // win32
  return `このシステムは Windows です。PowerShell コマンドで調査してください。
Bash ツールでは \`powershell -Command "..."\` の形式で実行できます。
   - \`powershell -Command "Get-Service | Where-Object {\\$_.Status -eq 'Running'} | Select-Object -First 30"\`
   - \`powershell -Command "Get-PSDrive -PSProvider FileSystem | Format-Table"\` (ディスク使用量)
   - \`powershell -Command "Get-Process | Sort-Object WorkingSet -Descending | Select-Object -First 20 Name,@{N='MB';E={[math]::Round(\\$_.WorkingSet/1MB)}}"\` (メモリ使用量)
   - \`docker ps\` (Dockerコンテナがあれば)
   - \`powershell -Command "Get-ScheduledTask | Where-Object {\\$_.State -eq 'Ready'} | Select-Object -First 30"\` (スケジュールタスク)`;
}

function buildSetupPrompt(userHint: string): string {
  return `あなたは cctimer のセットアップエージェントです。
ユーザーがこのマシンで定期監視したい内容を聞き取り、最適な監視設定を作成してください。

## ユーザーからの初期ヒント
${userHint || "（特になし）"}

## あなたのワークフロー

1. **システム調査**: まず Bash でこのマシンの状態を調べてください。
${getSystemInvestigationHint()}
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

// --- Main setup flow ---

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

  const mcpServerPath = resolve(__dirname, "mcp-server-entry.js");

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

  const savedMemory = state.getMemory();
  if (!savedMemory) {
    console.error("\n設定が保存されませんでした。再度セットアップしてください。");
    process.exit(1);
  }

  console.log("\n=== セットアップ完了 ===");
  console.log(`設定保存先: ${config.dataDir}`);

  // --- OS別デーモン起動方法の選択 ---
  const platform = process.platform;

  const serviceLabel =
    platform === "linux" ? "systemd サービスとして登録（推奨: 自動起動・自動復旧）" :
    platform === "darwin" ? "launchd エージェントとして登録（推奨: 自動起動）" :
    "Windows タスクスケジューラに登録（推奨: 自動起動）";

  console.log("\n監視デーモンの起動方法を選んでください:\n");
  console.log(`  1. ${serviceLabel}`);
  console.log("  2. このままフォアグラウンドで起動（Ctrl+C で停止）");
  console.log("  3. 後で手動で起動する\n");

  const choice = await prompt("選択 (1/2/3): ");

  switch (choice) {
    case "1": {
      if (platform === "linux") await installSystemdService();
      else if (platform === "darwin") await installLaunchdAgent();
      else await installWindowsTask();
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
      break;
    }
  }
}

// --- Service installers ---

async function installSystemdService(): Promise<void> {
  const projectDir = resolve(__dirname, "..");
  const nodeExec = process.execPath;
  const entryPoint = resolve(projectDir, "dist/index.js");
  const user = userInfo().username;
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
    const needsSudo = process.getuid?.() !== 0;
    const sudo = needsSudo ? "sudo " : "";

    const tmpPath = `/tmp/cctimer-${Date.now()}.service`;
    writeFileSync(tmpPath, serviceContent);

    execSync(`${sudo}cp ${tmpPath} ${servicePath}`, { stdio: "inherit" });
    execSync(`${sudo}systemctl daemon-reload`, { stdio: "inherit" });
    execSync(`${sudo}systemctl enable cctimer`, { stdio: "inherit" });
    execSync(`${sudo}systemctl start cctimer`, { stdio: "inherit" });
    execSync(`rm -f ${tmpPath}`);

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

async function installLaunchdAgent(): Promise<void> {
  const projectDir = resolve(__dirname, "..");
  const nodeExec = process.execPath;
  const entryPoint = resolve(projectDir, "dist/index.js");
  const logDir = resolve(homedir(), "Library/Logs/cctimer");

  mkdirSync(logDir, { recursive: true });

  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cctimer.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeExec}</string>
    <string>${entryPoint}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${projectDir}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logDir}/cctimer.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${logDir}/cctimer.stderr.log</string>
</dict>
</plist>
`;

  const plistDir = resolve(homedir(), "Library/LaunchAgents");
  mkdirSync(plistDir, { recursive: true });
  const plistPath = resolve(plistDir, "com.cctimer.agent.plist");

  console.log(`\nlaunchd エージェントを登録します...`);
  console.log(`  plist: ${plistPath}`);
  console.log(`  実行ファイル: ${nodeExec} ${entryPoint}`);
  console.log(`  ログ: ${logDir}/`);

  try {
    writeFileSync(plistPath, plistContent);
    execSync(`launchctl load "${plistPath}"`, { stdio: "inherit" });

    console.log("\n=== launchd エージェント登録完了 ===");
    console.log(`  状態確認: launchctl list | grep cctimer`);
    console.log(`  ログ:     tail -f ${logDir}/cctimer.stdout.log`);
    console.log(`  停止:     launchctl unload "${plistPath}"`);
    console.log(`  削除:     rm "${plistPath}"`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`\nlaunchd エージェントの登録に失敗しました: ${errMsg}`);
    process.exit(1);
  }
}

async function installWindowsTask(): Promise<void> {
  const projectDir = resolve(__dirname, "..");
  const nodeExec = process.execPath;
  const entryPoint = resolve(projectDir, "dist", "index.js");
  const taskName = "cctimer";

  console.log(`\nWindows タスクスケジューラに登録します...`);
  console.log(`  タスク名: ${taskName}`);
  console.log(`  実行ファイル: ${nodeExec} ${entryPoint}`);

  try {
    execSync(
      `schtasks /Create /TN "${taskName}" /TR "\\"${nodeExec}\\" \\"${entryPoint}\\"" /SC ONLOGON /F`,
      { stdio: "inherit" }
    );
    execSync(`schtasks /Run /TN "${taskName}"`, { stdio: "inherit" });

    console.log("\n=== Windows タスクスケジューラ登録完了 ===");
    console.log(`  状態確認: schtasks /Query /TN "${taskName}"`);
    console.log(`  停止:     schtasks /End /TN "${taskName}"`);
    console.log(`  削除:     schtasks /Delete /TN "${taskName}" /F`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`\nタスクスケジューラへの登録に失敗しました: ${errMsg}`);
    console.error("管理者として実行してみてください。");
    process.exit(1);
  }
}

setup().catch((err) => {
  console.error("Setup error:", err);
  process.exit(1);
});
