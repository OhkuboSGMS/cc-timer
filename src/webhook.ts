export interface WebhookPayload {
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  timestamp: string;
  runId: string;
}

export async function sendWebhook(url: string, payload: WebhookPayload): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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
