export interface WebhookPayload {
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  timestamp: string;
  runId: string;
}

const SEVERITY_COLORS: Record<string, number> = {
  info: 0x3498db,     // blue
  warning: 0xf39c12,  // orange
  critical: 0xe74c3c, // red
};

const SEVERITY_EMOJI: Record<string, string> = {
  info: "ℹ️",
  warning: "⚠️",
  critical: "🚨",
};

function isDiscordWebhook(url: string): boolean {
  return url.includes("discord.com/api/webhooks");
}

function buildDiscordBody(payload: WebhookPayload): object {
  return {
    embeds: [
      {
        title: `${SEVERITY_EMOJI[payload.severity]} [${payload.severity.toUpperCase()}] ${payload.title}`,
        description: payload.message,
        color: SEVERITY_COLORS[payload.severity] ?? 0x95a5a6,
        footer: { text: `cctimer run: ${payload.runId}` },
        timestamp: payload.timestamp,
      },
    ],
  };
}

export async function sendWebhook(url: string, payload: WebhookPayload): Promise<boolean> {
  try {
    const body = isDiscordWebhook(url)
      ? buildDiscordBody(payload)
      : payload;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.error(`[cctimer] Webhook failed: ${response.status} ${response.statusText}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[cctimer] Webhook error:`, err);
    return false;
  }
}
