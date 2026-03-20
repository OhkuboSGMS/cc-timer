#!/usr/bin/env node
/**
 * cctimer - Claude Code periodic monitoring daemon
 *
 * Main loop:
 * 1. Check if setup is complete
 * 2. Read schedule state for next run time
 * 3. Sleep until next run
 * 4. Check lock (skip if previous run still active)
 * 5. Launch CC agent for monitoring
 * 6. CC decides next run time via MCP tool
 * 7. Repeat
 */
import "dotenv/config";
import { loadConfig } from "./config.js";
import { StateManager } from "./state.js";
import { runMonitoringAgent } from "./agent.js";

const config = loadConfig();
const state = new StateManager(config);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg: string): void {
  console.log(`[cctimer ${new Date().toISOString()}] ${msg}`);
}

async function runOnce(): Promise<void> {
  if (state.isLocked()) {
    log("Previous run still active, skipping.");
    return;
  }

  if (!state.lock()) {
    log("Failed to acquire lock, skipping.");
    return;
  }

  try {
    const memory = state.getMemory();
    if (!memory) {
      log("No monitoring config found. Run 'cctimer-setup' first.");
      return;
    }

    const result = await runMonitoringAgent(config, memory);
    if (result.success) {
      log(`Run ${result.runId} completed successfully.`);
    } else {
      log(`Run ${result.runId} failed: ${result.output}`);
      // On failure, schedule a retry at default interval
      const schedule = state.getSchedule();
      if (!schedule.nextRunAt) {
        const next = new Date(Date.now() + config.defaultIntervalMin * 60 * 1000);
        state.setNextRun(next);
        log(`Scheduled retry at ${next.toISOString()}`);
      }
    }
  } finally {
    state.unlock();
  }
}

export async function daemon(): Promise<void> {
  log("cctimer daemon starting.");
  log(`Data dir: ${config.dataDir}`);
  log(`Work dir: ${config.workDir}`);
  log(`Default interval: ${config.defaultIntervalMin}min`);

  if (!state.isSetupComplete()) {
    log("Setup not complete. Run 'cctimer-setup' first.");
    process.exit(1);
  }

  // If no schedule exists, run immediately
  const schedule = state.getSchedule();
  if (!schedule.nextRunAt) {
    log("No schedule found. Running immediately.");
    state.setNextRun(new Date());
  }

  // Handle graceful shutdown
  let running = true;
  const shutdown = () => {
    log("Shutting down...");
    running = false;
    state.unlock();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (running) {
    const currentSchedule = state.getSchedule();
    const nextRunAt = currentSchedule.nextRunAt ? new Date(currentSchedule.nextRunAt) : new Date();
    const now = new Date();
    const waitMs = Math.max(0, nextRunAt.getTime() - now.getTime());

    if (waitMs > 0) {
      log(`Next run at ${nextRunAt.toISOString()} (${Math.round(waitMs / 60000)}min from now)`);
      // Sleep in 10s chunks so we can respond to signals
      const sleepUntil = Date.now() + waitMs;
      while (running && Date.now() < sleepUntil) {
        await sleep(Math.min(10000, sleepUntil - Date.now()));
      }
      if (!running) break;
    }

    await runOnce();
  }

  log("cctimer daemon stopped.");
}

// If run directly (not imported)
const isDirectRun = process.argv[1]?.endsWith("index.js");
if (isDirectRun) {
  daemon().catch((err) => {
    console.error("[cctimer] Fatal error:", err);
    process.exit(1);
  });
}
