import https from 'node:https';
import type { ResolvedWebhookDestination } from './webhook-security.js';

export interface WebhookTransportResponse { statusCode: number; }

/**
 * HTTPS request pinned to the validated address. One absolute timer covers
 * connection, TLS, upload, headers, and complete response-body consumption.
 */
export function postPinnedHttps(
  destination: ResolvedWebhookDestination,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<WebhookTransportResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, response?: WebhookTransportResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (error) reject(error); else resolve(response!);
    };
    const deadlineTimer = setTimeout(() => {
      request.destroy(new Error('webhook request timed out'));
    }, Math.max(1, timeoutMs));
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
      response.on('error', (error) => finish(error));
      response.on('end', () => finish(undefined, { statusCode: response.statusCode ?? 0 }));
      response.resume();
    });
    request.once('error', (error) => finish(error));
    request.end(body);
  });
}
