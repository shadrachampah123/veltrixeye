import * as React from 'react';
import type { Metadata } from 'next';
import { LegalPageView } from '@/components/legal';
import { RISK_COPY } from '@/lib/legal-copy';

/**
 * CL-1 — /legal/risk. Public static page (no auth, no API calls). Renders the
 * pinned risk disclaimer strings (RISK_DISCLAIMERS) that tests assert.
 */

export const metadata: Metadata = {
  title: 'Risk Disclosure',
  description: 'Draft risk disclosure for VeltrixEye: trading involves substantial risk of loss.',
};

export default function RiskPage() {
  return <LegalPageView page={RISK_COPY} />;
}
