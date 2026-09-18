import https from 'node:https';
import type { ResolvedWebhookDestination } from './webhook-security.js';

export interface WebhookTransportResponse { statusCode: number; }

/** HTTPS request pinned to the already-validated address; redirects are never followed. */
export function postPinnedHttps(
  destination: ResolvedWebhookDestination,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<WebhookTransportResponse> {
  return new Promise((resolve, reject) => {
    const request = https.request({
      protocol: 'https:',
      hostname: destination.address,
      port: destination.url.port ? Number(destination.url.port) : 443,
      path: `${destination.url.pathname}${destination.url.search}`,
      method: 'POST',
      headers,
      servername: destination.url.hostname.replace(/^\[|\]$/g, ''),
      rejectUnauthorized: true,
      ...(destination.ca ? { ca: destination.ca } : {}),
    }, (response) => {
      response.resume();
      resolve({ statusCode: response.statusCode ?? 0 });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('webhook request timed out')));
    request.once('error', reject);
    request.end(body);
  });
}
