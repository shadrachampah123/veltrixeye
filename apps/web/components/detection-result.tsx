'use client';

import * as React from 'react';
import Link from 'next/link';
import type { DetectionItemDto, DetectionResponseDto, SetupDto } from '@veltrixeye/contracts';
import { Alert, Badge, Card, CardHeader, Monospace } from '@/components/ui';
import { formatDateTime, formatPrice } from '@/lib/formats';
import {
  DETECTION_IDEMPOTENCE_NOTE,
  describeDetectionItem,
  detectionSummaryText,
  setupDetectorVersion,
  setupStateLabel,
  setupStateTone,
} from '@/lib/workbench';

/**
 * M4 detection result (M7.1) — presentational, prop-driven.
 *
 * The three outcomes the API can produce are rendered distinctly and never
 * blurred: a NEW setup (`created: true`), an idempotent replay that returned an
 * EXISTING setup (`created: false`), and a direction that produced no setup at
 * all. A replay is never called "created".
 */

function SetupFact({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wider text-ink-400">{label}</dt>
      <dd className={mono ? 'font-mono text-[13px] text-ink-100' : 'text-sm text-ink-100'}>{value}</dd>
    </div>
  );
}

function DetectionSetupFacts({ setup, detectorVersion }: { setup: SetupDto; detectorVersion: string | null }) {
  const detectedVersion = setupDetectorVersion(setup) ?? detectorVersion;
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
      <SetupFact
        label="Setup"
        value={
          <Link href={`/setups/${setup.id}`} className="underline underline-offset-2 hover:text-signal-400">
            open detail
          </Link>
        }
      />
      <SetupFact label="Setup id" value={setup.id} mono />
      <SetupFact label="State" value={setupStateLabel(setup.state)} />
      <SetupFact label="Version" value={`v${setup.versionNumber}`} />
      <SetupFact label="Entry" value={formatPrice(setup.entryPrice)} mono />
      <SetupFact label="Stop loss" value={formatPrice(setup.stopLossPrice)} mono />
      <SetupFact label="Take profit 1" value={formatPrice(setup.tp1Price)} mono />
      <SetupFact label="Take profit 2" value={formatPrice(setup.tp2Price)} mono />
      <SetupFact label="Take profit 3" value={formatPrice(setup.tp3Price)} mono />
      <SetupFact label="Detected" value={formatDateTime(setup.detectedAt)} />
      <SetupFact label="Expires" value={setup.expiresAt === null ? 'no expiry recorded' : formatDateTime(setup.expiresAt)} />
      <SetupFact
        label="Quality score"
        value={setup.qualityScore === null ? 'not scored yet' : String(setup.qualityScore)}
        mono
      />
      {detectedVersion && <SetupFact label="Detector version" value={detectedVersion} mono />}
    </dl>
  );
}

function DetectionItemView({ item, detectorVersion }: { item: DetectionItemDto; detectorVersion: string | null }) {
  const copy = describeDetectionItem(item);
  return (
    <div className="rounded-md border border-ink-700">
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-750 px-3.5 py-2.5">
        <Badge tone={item.direction === 'long' ? 'success' : 'danger'}>{item.direction}</Badge>
        <Badge tone={copy.tone}>{copy.title}</Badge>
        {item.setup && <Badge tone={setupStateTone(item.setup.state)}>{setupStateLabel(item.setup.state)}</Badge>}
        <span className="text-xs text-ink-400">
          evaluation {item.qualified ? 'qualified' : 'did not qualify'}
        </span>
      </div>
      <div className="space-y-3 px-3.5 py-3">
        <p className="text-xs text-ink-300">{copy.detail}</p>
        {item.setup ? (
          <DetectionSetupFacts setup={item.setup} detectorVersion={detectorVersion} />
        ) : (
          item.failureReasons.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-300">Evaluation failure reasons</p>
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-ink-300">
                {item.failureReasons.map((reason, index) => (
                  <li key={`${reason}-${index}`}>{reason}</li>
                ))}
              </ul>
            </div>
          )
        )}
      </div>
    </div>
  );
}

export function DetectionResultView({ result }: { result: DetectionResponseDto }) {
  const tally = detectionSummaryText(result);
  return (
    <Card>
      <CardHeader
        title="Detection result"
        subtitle={`${result.instrument.symbol} · ${result.instrument.assetClass} · ${tally}`}
        actions={<Badge tone="neutral">explicit run</Badge>}
      />
      <div className="space-y-3 px-5 py-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-ink-400">
          <span className="flex items-center gap-2">
            Detector <Monospace>{result.detectorVersion}</Monospace>
          </span>
          <span className="flex items-center gap-2">
            Engine <Monospace>{result.engineVersion}</Monospace>
          </span>
          <span className="flex items-center gap-2">
            Anchor <Monospace>{formatDateTime(new Date(result.asOfMs).toISOString())}</Monospace>
            <Monospace>{result.asOfMs}</Monospace>
          </span>
        </div>

        {result.detections.map((item) => (
          <DetectionItemView key={item.direction} item={item} detectorVersion={result.detectorVersion} />
        ))}

        <Alert tone="info" role="status">
          {DETECTION_IDEMPOTENCE_NOTE}
        </Alert>
      </div>
    </Card>
  );
}
