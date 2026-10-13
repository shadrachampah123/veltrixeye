import * as React from 'react';
import type { Metadata } from 'next';
import { LegalPageView } from '@/components/legal';
import { COOKIES_COPY } from '@/lib/legal-copy';

/**
 * CL-1 — /legal/cookies. Public static page (no auth, no API calls). The
 * inventory renders from STORAGE_FACTS, which is the complete list of browser
 * storage the product uses; tests pin that inventory and the notice's claims.
 */

export const metadata: Metadata = {
  title: 'Cookies & Local Storage',
  description: 'Cookie and browser-storage disclosure for VeltrixEye.',
};

export default function CookiesPage() {
  return <LegalPageView page={COOKIES_COPY} />;
}
