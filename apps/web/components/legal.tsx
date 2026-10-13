/**
 * CL-1 — presentational pieces for the legal pages and the shared legal links.
 *
 * Server-safe on purpose: no hooks, no browser APIs, no data fetching. The
 * authenticated app shell, the landing page, the auth pages and the legal
 * routes all render these; the copy itself lives in `lib/legal-copy.ts`.
 */
import * as React from 'react';
import Link from 'next/link';
import {
  LEGAL_COPY_STATUS,
  LEGAL_NAV,
  type LegalPageCopy,
} from '@/lib/legal-copy';

/** The banner every legal page shows so draft copy can never look final. */
export function LegalReviewBanner() {
  return (
    <div
      role="note"
      className="mb-6 rounded-md border border-amber-450/40 bg-amber-450/10 px-4 py-3 text-xs leading-relaxed text-amber-450"
      data-legal-status="draft"
    >
      <span className="font-semibold uppercase tracking-wider">{LEGAL_COPY_STATUS.label}</span>
      <span className="mt-1 block text-ink-300">{LEGAL_COPY_STATUS.note}</span>
    </div>
  );
}

/** The four-page nav shown on every legal page. */
export function LegalNav({ current }: { current?: string }) {
  return (
    <nav aria-label="Legal documents" className="mb-8 flex flex-wrap gap-2">
      {LEGAL_NAV.map((item) => {
        const active = item.href === current;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
              active
                ? 'border-signal-500/50 bg-signal-600/15 text-signal-400'
                : 'border-ink-700 bg-ink-800 text-ink-300 hover:border-ink-600 hover:text-ink-100'
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * The shared legal footer links. Used on the landing page, login, registration
 * and the authenticated app shell footer — always same-origin, text-only.
 */
export function LegalFooter({ className = '' }: { className?: string }) {
  return (
    <nav aria-label="Legal" className={`flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] text-ink-500 ${className}`.trim()}>
      {LEGAL_NAV.map((item) => (
        <Link key={item.href} href={item.href} className="hover:text-ink-200 hover:underline">
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

/** Renders one legal document from the copy module. */
export function LegalPageView({ page }: { page: LegalPageCopy }) {
  return (
    <article className="mx-auto w-full max-w-3xl">
      <LegalReviewBanner />
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink-50">{page.title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-400">{page.summary}</p>
      </header>
      <LegalNav current={page.href} />
      <div className="space-y-8">
        {page.sections.map((section) => (
          <section key={section.id} aria-labelledby={`legal-${section.id}`}>
            <h2 id={`legal-${section.id}`} className="mb-2 text-base font-semibold text-ink-100">
              {section.heading}
            </h2>
            <div className="space-y-3">
              {section.paragraphs.map((paragraph, index) => (
                <p key={index} className="text-sm leading-relaxed text-ink-300">
                  {paragraph}
                </p>
              ))}
            </div>
          </section>
        ))}
      </div>
      <footer className="mt-10 border-t border-ink-800 pt-5">
        <LegalFooter />
      </footer>
    </article>
  );
}
