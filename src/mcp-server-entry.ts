#!/usr/bin/env node
/**
 * MCP server entry point - runs as a subprocess spawned by the Agent SDK.
 * Config is passed via environment variables.
 */
import "dotenv/config";
import { loadConfig } from "./config.js";
import { startMcpServer } from "./mcp-server.js";

const config = loadConfig();
startMcpServer(config).catch((err) => {
  console.error("[cctimer-mcp] Fatal error:", err);
  process.exit(1);
});
