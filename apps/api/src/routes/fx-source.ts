import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import type { AppConfig } from '../config.js';
import { consoleFxSourceLogger, runFxSourceCheckOnce } from '../fx-source-runner.js';

/**
 * Billing FX **source observation** routes — the sleep-safe scheduled surface.
 *
 * | Route | Auth | Notes |
 * |---|---|---|
 * | POST /api/internal/billing/fx/source-check | worker token | One read-only observation check: reads the approved publisher's page once, validates and records what was published, and reports staleness. 404 when no token is configured. |
 *
 * WHY AN INTERNAL ROUTE AND NOT A PUBLIC ONE. This is the only surface that
 * causes an outbound call, so it is reachable only with a shared secret the
 * deployment sets (`FX_SOURCE_WORKER_TOKEN`). With no token configured the route
 * is not registered at all (404) — an unconfigured deployment has no
 * administrative surface, which is the same posture as the scanner and
 * notification worker routes.
 *
 * WHAT THE RESPONSE CONTAINS, AND WHAT IT DELIBERATELY DOES NOT.
 *  - It DOES contain: the publisher's own publication date, the exact figures as
 *    published, the source URL, staleness state and age, whether the row was
 *    newly recorded or already known, the content digests, and the standing
 *    decision (`need_source`, `published: false`, `approved: false`).
 *  - It does NOT contain: the publisher's page (never stored, never echoed), a
 *    token, a connection string, a raw error message, or any claim that a rate
 *    has been approved or published. There is no field in the response a caller
 *    could mistake for an authoritative billing rate.
 *
 * There is NO route that publishes, approves, applies or promotes an
 * observation: publication stays `billing:fx:validate` plus a separately
 * approved operator operation against the FX authority.
 */

/** Header carrying the shared FX source worker secret. */
export const FX_SOURCE_WORKER_TOKEN_HEADER = 'x-veltrixeye-worker-token';

/** True when a token is configured (otherwise the route does not exist). */
export function hasFxSourceWorkerToken(config: AppConfig): boolean {
  return config.fxSource.workerToken !== '';
}

/**
 * Constant-time token comparison over SHA-256 digests: comparing raw strings
 * leaks length and prefix through timing; hashing first makes both inputs 32
 * bytes so `timingSafeEqual` is constant-time regardless of token length.
 */
export function fxSourceTokenMatches(
  req: { headers: Record<string, string | string[] | undefined> },
  config: AppConfig,
): boolean {
  if (!hasFxSourceWorkerToken(config)) return false;
  const raw = req.headers[FX_SOURCE_WORKER_TOKEN_HEADER];
  const presented = Array.isArray(raw) ? raw[0] : raw;
  if (typeof presented !== 'string' || presented === '') return false;
  const expected = createHash('sha256').update(config.fxSource.workerToken).digest();
  const actual = createHash('sha256').update(presented).digest();
  return timingSafeEqual(expected, actual);
}

export async function fxSourceRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  config: AppConfig,
): Promise<void> {
  // Registered only when a token exists: with no token the path is a plain 404,
  // exactly like the scanner/notification worker routes.
  if (!hasFxSourceWorkerToken(config)) return;

  // Low ceiling: one scheduler (or a handful of retries) is the intended
  // caller, and every call can cause one outbound read.
  const internalRateLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
  const logger = consoleFxSourceLogger('[fx-source]');

  app.post('/api/internal/billing/fx/source-check', internalRateLimit, async (req, reply) => {
    if (!fxSourceTokenMatches(req, config)) {
      return reply.code(401).send({ error: { code: 'unauthorized', message: 'Unauthorized' } });
    }

    const outcome = await runFxSourceCheckOnce(ctx.fxSource, { logger, retrievedBy: 'scheduler' });
    if (!outcome.ok || outcome.result === null) {
      // The check itself failed (for example the database session for the
      // overlap guard could not be opened). No error text or secret is echoed.
      return reply.code(503).send({
        status: 'failed',
        error: { code: 'fx_source_check_failed', message: 'The FX source observation check did not complete.' },
      });
    }

    const result = outcome.result;
    return reply.code(200).send({
      status: result.overlapSkipped ? 'skipped' : 'ok',
      checkedAt: result.checkedAt,
      sourceId: result.sourceId,
      sourceUrl: result.sourceUrl,
      overlapSkipped: result.overlapSkipped,
      retrieval: {
        outcome: result.retrieval.outcome,
        reason: result.retrieval.reason,
        bodyDigest: result.retrieval.bodyDigest,
        rowDigest: result.retrieval.rowDigest,
      },
      validation: result.validation,
      record: result.record,
      report: {
        state: result.report.state,
        observed: result.report.observed,
        ageSeconds: result.report.ageSeconds,
        publishedOn: result.report.latest?.publishedOn ?? null,
        midRateDecimal: result.report.latest?.midRateDecimal ?? null,
        buyingDecimal: result.report.latest?.buyingDecimal ?? null,
        sellingDecimal: result.report.latest?.sellingDecimal ?? null,
        retrievedAt: result.report.latest?.retrievedAt ?? null,
        changed: result.report.changed,
        midChangeDecimal: result.report.midChangeDecimal,
        observationsRetained: result.report.observationsRetained,
        warningAfterSeconds: result.report.warningAfterSeconds,
        staleAfterSeconds: result.report.staleAfterSeconds,
        pricingPolicySatisfiable: result.report.pricingPolicySatisfiable,
        pricingPolicyReason: result.report.pricingPolicyReason,
      },
      // The standing boundary, restated on every response so no caller can read
      // an observation as an approval or as a published rate.
      decision: result.decision,
      decisionReason: result.decisionReason,
      published: false as const,
      approved: false as const,
      databaseWrites: result.databaseWrites,
      limitations: result.limitations,
    });
  });
}
