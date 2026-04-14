/**
 * Send test results to Slack or an arbitrary webhook.
 *
 * Slack: uses Incoming Webhook URL format (no bot token needed).
 * Webhook: POST JSON payload to any URL.
 */

export interface NotifyPayload {
  suiteResults: Array<{ name: string; status: string; reason: string }>;
  passed: number;
  failed: number;
  total: number;
  duration?: number;
  model?: string;
  platform?: string;
}

/**
 * Send results to a Slack Incoming Webhook.
 */
export async function notifySlack(
  webhookUrl: string,
  payload: NotifyPayload,
): Promise<void> {
  const icon = payload.failed === 0 ? ":white_check_mark:" : ":x:";
  const headline = `${icon} AppCrawl: ${payload.passed}/${payload.total} tests passed`;

  const lines = payload.suiteResults.map((r) => {
    const emoji = r.status === "pass" ? ":large_green_circle:" : r.status === "fail" ? ":red_circle:" : ":warning:";
    const detail = r.status !== "pass" ? ` — ${r.reason}` : "";
    return `${emoji} ${r.name}${detail}`;
  });

  const meta: string[] = [];
  if (payload.model) meta.push(`Model: \`${payload.model}\``);
  if (payload.platform) meta.push(`Platform: \`${payload.platform}\``);
  if (payload.duration) meta.push(`Duration: ${payload.duration}s`);

  const slackBody = {
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: headline },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: lines.join("\n") },
      },
      ...(meta.length > 0
        ? [{
            type: "context",
            elements: [{ type: "mrkdwn", text: meta.join(" | ") }],
          }]
        : []),
    ],
  };

  const resp = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(slackBody),
  });

  if (!resp.ok) {
    throw new Error(`Slack webhook failed: ${resp.status} ${await resp.text()}`);
  }
}

/**
 * Send results to an arbitrary webhook URL as JSON.
 */
export async function notifyWebhook(
  webhookUrl: string,
  payload: NotifyPayload,
): Promise<void> {
  const body = {
    event: "appcrawl.suite.complete",
    timestamp: new Date().toISOString(),
    ...payload,
  };

  const resp = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`Webhook failed: ${resp.status} ${await resp.text()}`);
  }
}
