'use client';

import * as React from 'react';
import { STUB_DELIVERY_BODY, STUB_DELIVERY_TITLE } from '@/lib/alerts-view';

/**
 * The single source of truth for M6's delivery disclaimer.
 *
 * M6 records alert deliveries on a local **stub** channel and transmits
 * nothing. This notice is rendered on every surface that shows or creates an
 * alert (list, detail, generate) so no screen can imply that an email, webhook,
 * push, SMS or broker notification went out. There is intentionally no
 * notification-provider configuration anywhere in the UI.
 */
export function StubDeliveryNotice({ className = '' }: { className?: string }) {
  return (
    <div
      className={`rounded-md border border-amber-450/40 bg-amber-450/10 px-3.5 py-3 text-sm text-amber-450 ${className}`}
    >
      <h3 className="mb-1 text-sm font-semibold">{STUB_DELIVERY_TITLE}</h3>
      <p className="text-amber-450/90">{STUB_DELIVERY_BODY}</p>
    </div>
  );
}

/** Compact inline variant for tables/cards where a banner is too heavy. */
export function StubDeliveryHint() {
  return (
    <p className="text-xs text-ink-400">
      Recorded on the stub ledger only — no external notification was sent.
    </p>
  );
}
