#!/usr/bin/env node
/**
 * cctimer-setup - Interactive setup using CC agent
 *
 * Launches a CC session that interviews the user about:
 * - What services/logs to monitor
 * - What constitutes an issue
 * - Notification preferences
 * Then saves the monitoring configuration.
 */
import "dotenv/config";
import { loadConfig } from "./config.js";
import { StateManager } from "./state.js";
import type { MonitoringMemory } from "./state.js";
import { createInterface } from "node:readline";

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

async function setup(): Promise<void> {
  console.log("=== cctimer setup ===\n");

  if (!config.anthropicApiKey) {
    console.error("ERROR: ANTHROPIC_API_KEY is not set.");
    console.error("Set it in .env or export ANTHROPIC_API_KEY=...");
    process.exit(1);
  }

  const existingMemory = state.getMemory();
  if (existingMemory) {
    const answer = await prompt("Monitoring config already exists. Overwrite? (y/N): ");
    if (answer.toLowerCase() !== "y") {
      console.log("Setup cancelled.");
      return;
    }
  }

  console.log("What should cctimer monitor? Describe your monitoring targets.\n");
  console.log("Examples:");
  console.log("  - Check systemd service logs for errors");
  console.log("  - Monitor application log files in /var/log/myapp/");
  console.log("  - Check disk usage and memory");
  console.log("  - Verify API endpoints are responding\n");

  const targets = await prompt("Monitoring targets (comma-separated): ");
  if (!targets) {
    console.error("No targets specified. Aborting.");
    process.exit(1);
  }

  const instructions = await prompt(
    "\nAny additional instructions for the monitoring agent?\n" +
    "(e.g., 'ignore warnings about deprecated TLS', 'critical if disk > 90%')\n> "
  );

  const checkTargets = targets.split(",").map((t) => t.trim()).filter(Boolean);

  const memory: MonitoringMemory = {
    instructions: instructions || "Monitor the specified targets for errors, warnings, and anomalies.",
    checkTargets,
    additionalNotes: [],
    updatedAt: new Date().toISOString(),
  };

  state.setMemory(memory);

  // Set initial schedule - run immediately
  state.setNextRun(new Date());

  console.log("\n=== Setup complete ===");
  console.log(`Monitoring targets: ${checkTargets.join(", ")}`);
  console.log(`Instructions: ${memory.instructions}`);
  console.log(`Config saved to: ${config.dataDir}`);
  console.log(`\nStart the daemon with: cctimer`);

  // Optionally, offer to do a test run
  const testRun = await prompt("\nRun a test monitoring session now? (y/N): ");
  if (testRun.toLowerCase() === "y") {
    console.log("\nLaunching test monitoring session...\n");
    const { runMonitoringAgent } = await import("./agent.js");
    const result = await runMonitoringAgent(config, memory);
    console.log(`\nTest run ${result.runId}: ${result.success ? "SUCCESS" : "FAILED"}`);
    if (result.output) {
      console.log("Output:", result.output.slice(0, 500));
    }
  }
}

setup().catch((err) => {
  console.error("Setup error:", err);
  process.exit(1);
});
