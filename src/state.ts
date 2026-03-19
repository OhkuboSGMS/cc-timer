import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { CctimerConfig } from "./config.js";

export interface RunRecord {
  runId: string;
  startedAt: string;
  finishedAt: string;
  summary: string;
  issuesFound: boolean;
  nextRunAt: string;
}

export interface ScheduleState {
  nextRunAt: string | null;
  lastRunId: string | null;
}

export interface MonitoringMemory {
  instructions: string;
  checkTargets: string[];
  additionalNotes: string[];
  updatedAt: string;
}

export class StateManager {
  private dataDir: string;
  private lockFile: string;
  private scheduleFile: string;
  private historyFile: string;
  private memoryFile: string;

  constructor(config: CctimerConfig) {
    this.dataDir = config.dataDir;
    this.lockFile = resolve(this.dataDir, "cctimer.lock");
    this.scheduleFile = resolve(this.dataDir, "schedule.json");
    this.historyFile = resolve(this.dataDir, "history.json");
    this.memoryFile = resolve(this.dataDir, "memory.json");
    this.ensureDataDir();
  }

  private ensureDataDir(): void {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
  }

  // --- Lock management ---

  isLocked(): boolean {
    if (!existsSync(this.lockFile)) return false;
    try {
      const data = JSON.parse(readFileSync(this.lockFile, "utf-8"));
      const pid = data.pid as number;
      // Check if process is still alive
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        // Process is dead, stale lock
        this.unlock();
        return false;
      }
    } catch {
      return false;
    }
  }

  lock(): boolean {
    if (this.isLocked()) return false;
    writeFileSync(this.lockFile, JSON.stringify({ pid: process.pid, lockedAt: new Date().toISOString() }));
    return true;
  }

  unlock(): void {
    try {
      unlinkSync(this.lockFile);
    } catch {
      // ignore
    }
  }

  // --- Schedule ---

  getSchedule(): ScheduleState {
    if (!existsSync(this.scheduleFile)) {
      return { nextRunAt: null, lastRunId: null };
    }
    return JSON.parse(readFileSync(this.scheduleFile, "utf-8"));
  }

  setNextRun(nextRunAt: Date, lastRunId?: string): void {
    const current = this.getSchedule();
    const state: ScheduleState = {
      nextRunAt: nextRunAt.toISOString(),
      lastRunId: lastRunId ?? current.lastRunId,
    };
    writeFileSync(this.scheduleFile, JSON.stringify(state, null, 2));
  }

  // --- History ---

  getHistory(limit: number = 20): RunRecord[] {
    if (!existsSync(this.historyFile)) return [];
    const records: RunRecord[] = JSON.parse(readFileSync(this.historyFile, "utf-8"));
    return records.slice(-limit);
  }

  addRecord(record: RunRecord): void {
    const records = this.getHistory(1000);
    records.push(record);
    // Keep last 1000 records
    const trimmed = records.slice(-1000);
    writeFileSync(this.historyFile, JSON.stringify(trimmed, null, 2));
  }

  // --- Monitoring memory ---

  getMemory(): MonitoringMemory | null {
    if (!existsSync(this.memoryFile)) return null;
    return JSON.parse(readFileSync(this.memoryFile, "utf-8"));
  }

  setMemory(memory: MonitoringMemory): void {
    writeFileSync(this.memoryFile, JSON.stringify(memory, null, 2));
  }

  updateMemoryNotes(note: string): void {
    const memory = this.getMemory();
    if (!memory) return;
    memory.additionalNotes.push(note);
    memory.updatedAt = new Date().toISOString();
    this.setMemory(memory);
  }

  isSetupComplete(): boolean {
    return this.getMemory() !== null;
  }
}
