import * as React from 'react';
import type { Metadata } from 'next';
import { LegalPageView } from '@/components/legal';
import { PRIVACY_COPY } from '@/lib/legal-copy';

/**
 * CL-1 — /legal/privacy. Public static page (no auth, no API calls). Copy is a
 * DRAFT rendered from lib/legal-copy.ts and states only verified behavior;
 * anything requiring operator/counsel input stays bracketed.
 */

export const metadata: Metadata = {
  title: 'Privacy Notice',
  description: 'Draft privacy notice for VeltrixEye.',
};

export default function PrivacyPage() {
  return <LegalPageView page={PRIVACY_COPY} />;
}
