'use client';

import * as React from 'react';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Spinner } from '@/components/ui';
import { LegalFooter } from '@/components/legal';
import { api } from '@/lib/api';

export default function IndexPage() {
  const router = useRouter();
  useEffect(() => {
    api
      .me()
      .then(() => router.replace('/dashboard'))
      .catch(() => router.replace('/login'));
  }, [router]);
  return (
    <div className="flex min-h-screen flex-col">
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
      <footer className="border-t border-ink-800 px-4 py-4">
        <LegalFooter />
      </footer>
    </div>
  );
}
