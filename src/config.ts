import { resolve } from "node:path";
import { homedir } from "node:os";

export interface CctimerConfig {
  anthropicApiKey: string;
  webhookUrl: string;
  dataDir: string;
  workDir: string;
  defaultIntervalMin: number;
  maxIntervalMin: number;
  minIntervalMin: number;
}

export function loadConfig(): CctimerConfig {
  const dataDir = process.env.CCTIMER_DATA_DIR || resolve(homedir(), ".cctimer");

  return {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
    webhookUrl: process.env.CCTIMER_WEBHOOK_URL || "",
    dataDir,
    workDir: process.env.CCTIMER_WORK_DIR || process.cwd(),
    defaultIntervalMin: parseInt(process.env.CCTIMER_DEFAULT_INTERVAL_MIN || "30", 10),
    maxIntervalMin: parseInt(process.env.CCTIMER_MAX_INTERVAL_MIN || "1440", 10),
    minIntervalMin: parseInt(process.env.CCTIMER_MIN_INTERVAL_MIN || "5", 10),
  };
}
