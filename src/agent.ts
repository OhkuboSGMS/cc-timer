/**
 * Agent runner - launches CC via Agent SDK for a monitoring session
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { mkdirSync, createWriteStream } from "node:fs";
import { resolve } from "node:path";
import type { CctimerConfig } from "./config.js";
import type { MonitoringMemory } from "./state.js";

function buildMonitoringPrompt(memory: MonitoringMemory, runId: string): string {
  const checkTargets = memory.checkTargets.map((t) => `  - ${t}`).join("\n");
  const notes = memory.additionalNotes.length > 0
    ? "\n\nAdditional notes from previous runs:\n" + memory.additionalNotes.map((n) => `  - ${n}`).join("\n")
    : "";

  return `You are a monitoring agent (run ID: ${runId}). Your job is to check the system health.

## Monitoring Instructions
${memory.instructions}

## What to Check
${checkTargets}
${notes}

## Your Workflow
1. First, call \`get_monitoring_config\` to get the latest monitoring configuration.
2. Call \`get_run_history\` to review recent monitoring results and identify trends.
3. Check each target by reading logs, checking service status, examining files, etc.
4. If you find any issues requiring human attention, call \`send_notification\` with appropriate severity.
5. Call \`record_run_result\` with a summary of what you found.
6. If you noticed something worth remembering for future runs, call \`update_monitoring_notes\`.
7. Finally, call \`schedule_next_run\` to decide when to run next:
   - If everything is healthy and stable: use a longer interval (e.g., 30-60 min)
   - If minor issues detected: use a shorter interval (e.g., 10-15 min)
   - If critical issues detected: use the minimum interval (e.g., 5 min)
   - Consider time of day and historical patterns

IMPORTANT: You MUST call \`schedule_next_run\` and \`record_run_result\` before finishing.`;
}

export interface RunResult {
  runId: string;
  success: boolean;
  output: string;
}

export async function runMonitoringAgent(
  config: CctimerConfig,
  memory: MonitoringMemory,
): Promise<RunResult> {
  const runId = randomUUID().slice(0, 8);
  const startedAt = new Date().toISOString();
  const prompt = buildMonitoringPrompt(memory, runId);

  // Resolve the MCP server entry point path
  const mcpServerPath = new URL("./mcp-server-entry.js", import.meta.url).pathname;

  console.log(`[cctimer] Starting monitoring run ${runId}`);

  // ラン毎のログディレクトリ
  const runsDir = resolve(config.dataDir, "runs");
  mkdirSync(runsDir, { recursive: true });
  const logPath = resolve(runsDir, `${runId}.log`);
  const logStream = createWriteStream(logPath, { flags: "w" });

  function writeLog(line: string): void {
    logStream.write(`[${new Date().toISOString()}] ${line}\n`);
  }

  writeLog(`=== Monitoring Run ${runId} ===`);
  writeLog(`Started: ${startedAt}`);
  writeLog(`Work dir: ${config.workDir}`);
  writeLog("");

  const outputParts: string[] = [];

  try {
    for await (const message of query({
      prompt,
      options: {
        allowedTools: ["Read", "Glob", "Grep", "Bash", "WebFetch"],
        permissionMode: "bypassPermissions",
        cwd: config.workDir,
        mcpServers: {
          cctimer: {
            command: "node",
            args: [mcpServerPath],
            env: {
              ...process.env as Record<string, string>,
              CCTIMER_RUN_ID: runId,
              CCTIMER_RUN_STARTED_AT: startedAt,
            },
          },
        },
      },
    })) {
      if (message.type === "assistant" && message.message?.content) {
        for (const block of message.message.content) {
          if ("text" in block) {
            outputParts.push(block.text as string);
            writeLog(`[assistant] ${block.text}`);
          } else if ("type" in block && block.type === "tool_use") {
            const tb = block as any;
            writeLog(`[tool_call] ${tb.name}(${JSON.stringify(tb.input)})`);
          }
        }
      } else if (message.type === "result") {
        const subtype = (message as any).subtype;
        writeLog(`[result] ${subtype}`);
        console.log(`[cctimer] Run ${runId} completed: ${subtype}`);
      }
    }

    writeLog("");
    writeLog(`=== Run ${runId} finished successfully ===`);
    logStream.end();

    return { runId, success: true, output: outputParts.join("\n") };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    writeLog(`[error] ${errMsg}`);
    writeLog(`=== Run ${runId} failed ===`);
    logStream.end();
    console.error(`[cctimer] Run ${runId} failed:`, errMsg);
    return { runId, success: false, output: errMsg };
  }
}
