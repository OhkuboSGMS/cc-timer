/**
 * MCP Server for cctimer
 *
 * Provides tools that the CC agent calls during monitoring:
 * - schedule_next_run: CC decides when to run next
 * - send_notification: CC sends alert via webhook
 * - get_run_history: CC reads past monitoring results
 * - get_monitoring_config: CC reads what to monitor
 * - update_monitoring_notes: CC updates monitoring instructions
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { resolve } from "node:path";
import { getDirname } from "./paths.js";
import type { CctimerConfig } from "./config.js";
import { StateManager } from "./state.js";
import { sendWebhook } from "./webhook.js";

const __dirname = getDirname(import.meta.url);

export function createMcpServerArgs(config: CctimerConfig): { command: string; args: string[] } {
  // The MCP server runs as a subprocess via tsx or node
  // We pass config via environment variables
  return {
    command: "node",
    args: [resolve(__dirname, "mcp-server-entry.js")],
  };
}

export async function startMcpServer(config: CctimerConfig): Promise<void> {
  const state = new StateManager(config);

  const server = new Server(
    { name: "cctimer", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "schedule_next_run",
        description:
          "Schedule the next monitoring run. Call this at the end of every monitoring session. " +
          "You decide the interval based on the current system state: " +
          "shorter intervals if issues are detected or things are unstable, " +
          "longer intervals if everything is healthy.",
        inputSchema: {
          type: "object" as const,
          properties: {
            minutes_from_now: {
              type: "number",
              description: `Minutes until next run (min: ${config.minIntervalMin}, max: ${config.maxIntervalMin})`,
            },
            reason: {
              type: "string",
              description: "Why you chose this interval",
            },
          },
          required: ["minutes_from_now", "reason"],
        },
      },
      {
        name: "send_notification",
        description:
          "Send a notification via webhook. Use this when you find issues that need human attention. " +
          "Choose severity: info (FYI), warning (needs attention soon), critical (needs immediate attention).",
        inputSchema: {
          type: "object" as const,
          properties: {
            severity: {
              type: "string",
              enum: ["info", "warning", "critical"],
              description: "Notification severity level",
            },
            title: {
              type: "string",
              description: "Short summary of the issue (one line)",
            },
            message: {
              type: "string",
              description: "Detailed description of the issue and any recommendations",
            },
          },
          required: ["severity", "title", "message"],
        },
      },
      {
        name: "get_run_history",
        description:
          "Get the history of past monitoring runs. Use this to understand trends " +
          "and compare current state with previous observations.",
        inputSchema: {
          type: "object" as const,
          properties: {
            limit: {
              type: "number",
              description: "Number of recent runs to retrieve (default: 10)",
            },
          },
        },
      },
      {
        name: "get_monitoring_config",
        description:
          "Get the current monitoring configuration: what to check, instructions, and any additional notes.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "update_monitoring_notes",
        description:
          "Add a note to the monitoring configuration. Use this to record observations, " +
          "patterns, or adjustments for future runs.",
        inputSchema: {
          type: "object" as const,
          properties: {
            note: {
              type: "string",
              description: "The note to add to the monitoring configuration",
            },
          },
          required: ["note"],
        },
      },
      {
        name: "record_run_result",
        description:
          "Record the result of this monitoring run. Call this at the end of every session " +
          "with a summary of what was checked and whether issues were found.",
        inputSchema: {
          type: "object" as const,
          properties: {
            summary: {
              type: "string",
              description: "Summary of what was checked and the results",
            },
            issues_found: {
              type: "boolean",
              description: "Whether any issues were found during this run",
            },
          },
          required: ["summary", "issues_found"],
        },
      },
      {
        name: "save_monitoring_config",
        description:
          "Save the monitoring configuration. Used during setup to persist the monitoring " +
          "targets and instructions that the agent has gathered from the user and system inspection. " +
          "This also sets the initial schedule to run immediately.",
        inputSchema: {
          type: "object" as const,
          properties: {
            instructions: {
              type: "string",
              description: "Detailed monitoring instructions for future runs",
            },
            check_targets: {
              type: "array",
              items: { type: "string" },
              description: "List of specific things to monitor (services, logs, metrics, etc.)",
            },
            additional_notes: {
              type: "array",
              items: { type: "string" },
              description: "Any additional notes from system inspection",
            },
          },
          required: ["instructions", "check_targets"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const runId = process.env.CCTIMER_RUN_ID || "unknown";

    switch (name) {
      case "schedule_next_run": {
        let minutes = args?.minutes_from_now as number;
        minutes = Math.max(config.minIntervalMin, Math.min(config.maxIntervalMin, minutes));
        const nextRun = new Date(Date.now() + minutes * 60 * 1000);
        state.setNextRun(nextRun, runId);
        const reason = args?.reason as string;
        console.error(`[cctimer] Next run scheduled at ${nextRun.toISOString()} (${minutes}min) - ${reason}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `Next run scheduled at ${nextRun.toISOString()} (${minutes} minutes from now). Reason: ${reason}`,
            },
          ],
        };
      }

      case "send_notification": {
        const severity = args?.severity as "info" | "warning" | "critical";
        const title = args?.title as string;
        const message = args?.message as string;

        if (!config.webhookUrl) {
          return {
            content: [{ type: "text" as const, text: "Warning: No webhook URL configured. Notification logged only." }],
          };
        }

        const success = await sendWebhook(config.webhookUrl, {
          severity,
          title,
          message,
          timestamp: new Date().toISOString(),
          runId,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: success ? `Notification sent: [${severity}] ${title}` : "Failed to send notification. Check webhook configuration.",
            },
          ],
        };
      }

      case "get_run_history": {
        const limit = (args?.limit as number) || 10;
        const history = state.getHistory(limit);
        return {
          content: [
            {
              type: "text" as const,
              text: history.length === 0
                ? "No previous runs recorded."
                : JSON.stringify(history, null, 2),
            },
          ],
        };
      }

      case "get_monitoring_config": {
        const memory = state.getMemory();
        if (!memory) {
          return {
            content: [{ type: "text" as const, text: "No monitoring configuration found. Setup has not been run." }],
          };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(memory, null, 2) }],
        };
      }

      case "update_monitoring_notes": {
        const note = args?.note as string;
        state.updateMemoryNotes(note);
        return {
          content: [{ type: "text" as const, text: `Note added: ${note}` }],
        };
      }

      case "record_run_result": {
        const summary = args?.summary as string;
        const issuesFound = args?.issues_found as boolean;
        const schedule = state.getSchedule();

        state.addRecord({
          runId,
          startedAt: process.env.CCTIMER_RUN_STARTED_AT || new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          summary,
          issuesFound,
          nextRunAt: schedule.nextRunAt || "not scheduled",
        });

        return {
          content: [{ type: "text" as const, text: `Run result recorded. Issues found: ${issuesFound}` }],
        };
      }

      case "save_monitoring_config": {
        const instructions = args?.instructions as string;
        const checkTargets = args?.check_targets as string[];
        const additionalNotes = (args?.additional_notes as string[]) || [];

        const memory = {
          instructions,
          checkTargets,
          additionalNotes,
          updatedAt: new Date().toISOString(),
        };
        state.setMemory(memory);
        state.setNextRun(new Date());

        return {
          content: [
            {
              type: "text" as const,
              text: `Monitoring config saved. Targets: ${checkTargets.join(", ")}. Initial run scheduled.`,
            },
          ],
        };
      }

      default:
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
