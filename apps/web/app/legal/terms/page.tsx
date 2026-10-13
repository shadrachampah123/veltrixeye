import * as React from 'react';
import type { Metadata } from 'next';
import { LegalPageView } from '@/components/legal';
import { TERMS_COPY } from '@/lib/legal-copy';

/**
 * CL-1 — /legal/terms. Public static page (no auth, no API calls). Copy is a
 * DRAFT rendered from lib/legal-copy.ts; the page shows the review banner.
 */

export const metadata: Metadata = {
  title: 'Terms of Use',
  description: 'Draft terms of use for VeltrixEye.',
};

export default function TermsPage() {
  return <LegalPageView page={TERMS_COPY} />;
}
