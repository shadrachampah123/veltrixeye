'use client';

/**
 * CL-1 — the minimal cookie notice.
 *
 * Informational, not a consent gate: the session cookie is strictly necessary
 * for sign-in and nothing is conditional on this notice. The banner states only
 * verified facts (see lib/legal-copy.ts → STORAGE_FACTS / COOKIE_NOTICE) and
 * its dismissal is remembered in one localStorage key, disclosed in the copy.
 *
 * Pinned by tests (test/legal-pages.test.ts):
 *  - the ONLY browser storage this file touches is COOKIE_NOTICE_ACK_KEY;
 *  - no document.cookie access and no third-party script is ever introduced.
 */
import * as React from 'react';
import Link from 'next/link';
import { COOKIE_NOTICE } from '@/lib/legal-copy';

export const COOKIE_NOTICE_ACK_KEY = 'veltrixeye:cookie-notice.ack';

/** Pure banner markup — exported so tests can render it without a browser. */
export function CookieNoticeBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      role="region"
      aria-label={COOKIE_NOTICE.headline}
      data-cookie-notice="true"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-ink-700 bg-ink-900/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-ink-900/85"
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs leading-relaxed text-ink-300">
          <span className="font-semibold text-ink-100">{COOKIE_NOTICE.headline}:</span>{' '}
          {COOKIE_NOTICE.body}{' '}
          <Link href={COOKIE_NOTICE.learnMoreHref} className="text-signal-400 hover:underline">
            {COOKIE_NOTICE.learnMoreLabel}
          </Link>
        </p>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded-md border border-ink-600 bg-ink-800 px-3 py-1.5 text-xs font-medium text-ink-200 transition-colors hover:bg-ink-750 hover:text-ink-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-500"
        >
          {COOKIE_NOTICE.dismissLabel}
        </button>
      </div>
    </div>
  );
}

/** Mounts the banner until the acknowledgement key is present. */
export function CookieNotice() {
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    try {
      if (window.localStorage.getItem(COOKIE_NOTICE_ACK_KEY) !== 'true') setVisible(true);
    } catch {
      // Storage unavailable (private mode, blocked): show the notice anyway.
      setVisible(true);
    }
  }, []);

  const dismiss = React.useCallback(() => {
    setVisible(false);
    try {
      window.localStorage.setItem(COOKIE_NOTICE_ACK_KEY, 'true');
    } catch {
      // Ignore quota/private-mode failures — the notice stays dismissed for
      // this page view only.
    }
  }, []);

  if (!visible) return null;
  return <CookieNoticeBanner onDismiss={dismiss} />;
}
