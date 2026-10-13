/**
 * CL-1 — customer-facing legal & risk surface.
 *
 * These tests pin exactly what the roadmap slice promised:
 *  1. the four public page routes exist and render without auth or API access;
 *  2. navigation links to all four pages exist on the landing page, login,
 *     registration and the authenticated app shell;
 *  3. the risk disclaimer strings are present verbatim;
 *  4. privacy & cookie statements match VERIFIED product behavior (session
 *     cookie attributes, the complete browser-storage inventory, documented
 *     notification retention, no card storage) and invent nothing — draft copy
 *     stays marked, operator placeholders stay bracketed;
 *  5. the cookie notice's claims are accurate, it touches only its own
 *     localStorage key, and no external tracking script exists anywhere in
 *     the files this slice added or touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  COOKIES_COPY,
  COOKIE_NOTICE,
  LEGAL_COPY_STATUS,
  LEGAL_NAV,
  LEGAL_PLACEHOLDERS,
  PRIVACY_COPY,
  RISK_COPY,
  RISK_DISCLAIMERS,
  STORAGE_FACTS,
  TERMS_COPY,
  type LegalPageCopy,
} from '../lib/legal-copy';
import { LegalFooter, LegalNav, LegalPageView, LegalReviewBanner } from '../components/legal';
import { CookieNoticeBanner, COOKIE_NOTICE_ACK_KEY } from '../components/cookie-notice';
import TermsPage from '../app/legal/terms/page';
import PrivacyPage from '../app/legal/privacy/page';
import RiskPage from '../app/legal/risk/page';
import CookiesPage from '../app/legal/cookies/page';

const srcPath = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const src = (rel: string) => readFileSync(srcPath(rel), 'utf8');
/** Source with comments stripped — assertions pin CODE, not documentation. */
const code = (rel: string) =>
  src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const PAGE_FILES = [
  '../app/legal/layout.tsx',
  '../app/legal/terms/page.tsx',
  '../app/legal/privacy/page.tsx',
  '../app/legal/risk/page.tsx',
  '../app/legal/cookies/page.tsx',
] as const;

const ALL_COPIES: LegalPageCopy[] = [TERMS_COPY, PRIVACY_COPY, RISK_COPY, COOKIES_COPY];

/* ------------------------------------------------------------------ */
/* 1. Page routes                                                      */
/* ------------------------------------------------------------------ */

test('all four legal routes exist at their public paths', () => {
  for (const rel of PAGE_FILES) {
    assert.ok(existsSync(srcPath(rel)), `${rel} exists`);
  }
});

test('each page renders its document: title, sections and pinned href', () => {
  const rendered: Array<[LegalPageCopy, string]> = [
    [TERMS_COPY, renderToStaticMarkup(React.createElement(TermsPage))],
    [PRIVACY_COPY, renderToStaticMarkup(React.createElement(PrivacyPage))],
    [RISK_COPY, renderToStaticMarkup(React.createElement(RiskPage))],
    [COOKIES_COPY, renderToStaticMarkup(React.createElement(CookiesPage))],
  ];
  for (const [copy, html] of rendered) {
    assert.ok(html.includes(`href="${copy.href}"`), `${copy.href} marks its own nav entry`);
    const escapedTitle = copy.title.replace(/&/g, '&amp;');
    assert.ok(
      html.includes(copy.title) || html.includes(escapedTitle),
      `${copy.href} renders its title`,
    );
    assert.ok(html.length > 1500, `${copy.href} renders a full document`);
    for (const section of copy.sections) {
      assert.ok(html.includes(section.heading), `${copy.href} renders section "${section.heading}"`);
    }
  }
});

test('legal pages are public: no auth, no API, no redirect logic in the route tree', () => {
  for (const rel of PAGE_FILES) {
    const source = code(rel);
    assert.ok(!source.includes('auth-context'), `${rel} does not gate on auth`);
    assert.ok(!source.includes('RequireAuth'), `${rel} does not require a session`);
    assert.ok(!source.includes('lib/api'), `${rel} makes no API calls`);
    assert.ok(!source.includes('useRouter'), `${rel} performs no client redirects`);
    assert.ok(!source.includes("'use client'"), `${rel} stays a server component`);
  }
});

/* ------------------------------------------------------------------ */
/* 2. Navigation links                                                 */
/* ------------------------------------------------------------------ */

test('LegalFooter and LegalNav link to all four documents (same-origin)', () => {
  const rendered = [
    renderToStaticMarkup(React.createElement(LegalFooter, {})),
    renderToStaticMarkup(React.createElement(LegalNav, {})),
  ];
  for (const html of rendered) {
    for (const item of LEGAL_NAV) {
      assert.ok(html.includes(`href="${item.href}"`), `nav links to ${item.href}`);
    }
    assert.ok(!html.includes('http'), 'nav links are same-origin only');
  }
});

test('landing, login, register and the app shell all render the legal links', () => {
  const surfaces: Array<[string, string]> = [
    ['landing', '../app/page.tsx'],
    ['login', '../app/login/page.tsx'],
    ['registration', '../app/register/page.tsx'],
    ['app shell', '../components/app-shell.tsx'],
  ];
  for (const [label, rel] of surfaces) {
    const source = src(rel);
    assert.ok(source.includes('LegalFooter'), `${label} renders the shared legal links`);
    assert.ok(source.includes('components/legal'), `${label} uses the shared legal module`);
  }
  // Hrefs live only in the copy module, so the four surfaces cannot drift.
  const legalSource = src('../lib/legal-copy.ts');
  for (const item of LEGAL_NAV) {
    assert.ok(legalSource.includes(item.href), `href ${item.href} defined in the copy module`);
  }
});

test('the legal layout links back to the product and to sign-in', () => {
  const layout = src('../app/legal/layout.tsx');
  assert.ok(layout.includes('href="/"'), 'brand links home');
  assert.ok(layout.includes('href="/login"'), 'sign-in is reachable');
});

/* ------------------------------------------------------------------ */
/* 3. Risk disclaimer copy                                             */
/* ------------------------------------------------------------------ */

test('pinned risk strings stay exactly as approved for pinning', () => {
  assert.deepEqual(
    [...RISK_DISCLAIMERS],
    [
      'VeltrixEye provides information and analysis tools only and does not provide investment advice.',
      'Trading alerts are suggestions, never orders.',
      'Trading involves substantial risk of loss.',
      'Past performance is not indicative of future results.',
      'Paper simulation results are not broker fills and are not a guarantee of future performance.',
    ],
  );
});

test('the risk page carries every pinned disclaimer verbatim', () => {
  const html = renderToStaticMarkup(React.createElement(RiskPage));
  for (const sentence of RISK_DISCLAIMERS) {
    assert.ok(html.includes(sentence), `risk page states: "${sentence}"`);
  }
});

test('terms of use repeat the no-advice statement', () => {
  const terms = renderToStaticMarkup(React.createElement(TermsPage));
  assert.ok(terms.includes(RISK_DISCLAIMERS[0]), 'terms carry the no-advice statement');
});

/* ------------------------------------------------------------------ */
/* 4. Privacy & cookie statements match verified behavior              */
/* ------------------------------------------------------------------ */

test('draft copy is clearly marked and never presented as approved', () => {
  assert.equal(LEGAL_COPY_STATUS.approved, false);
  const banner = renderToStaticMarkup(React.createElement(LegalReviewBanner));
  assert.ok(banner.includes('DRAFT'), 'banner says DRAFT');
  assert.ok(banner.includes('not counsel-approved'), 'banner denies counsel approval');
  assert.ok(banner.includes('data-legal-status="draft"'), 'machine-readable draft marker');
  for (const copy of ALL_COPIES) {
    const html = renderToStaticMarkup(React.createElement(LegalPageView, { page: copy }));
    assert.ok(html.includes('DRAFT'), `${copy.href} shows the draft banner`);
    assert.ok(html.includes('not counsel-approved'), `${copy.href} denies counsel approval`);
  }
});

test('operator-only facts stay bracketed placeholders — nothing invented', () => {
  const all = JSON.stringify(ALL_COPIES);
  for (const [name, value] of Object.entries(LEGAL_PLACEHOLDERS)) {
    assert.ok(all.includes(value), `placeholder ${name} appears in the copy`);
  }
  for (const forbidden of ['GDPR compliant', 'CCPA compliant', 'SOC 2', 'ISO 27001', 'fully compliant']) {
    assert.ok(!all.includes(forbidden), `copy never claims "${forbidden}"`);
  }
  assert.ok(!/\d+ [A-Z][a-z]+ (Street|St|Avenue|Ave|Road|Rd)\b/.test(all), 'no invented street address');
});

test('privacy page states only verified behavior', () => {
  const html = renderToStaticMarkup(React.createElement(PrivacyPage));
  const required = [
    'argon2id', // password hashing
    'SHA-256 hash of the session token', // hashed sessions
    'append-only', // audit log
    'IP address', // audit attribution
    'user-agent', // audit attribution
    '30 days', // delivered notification retention (documented default)
    '120 days', // failed notification retention (documented default)
    'never stored by VeltrixEye', // no card/bank details
    'encrypted at rest', // push subscription keys / secrets
    STORAGE_FACTS.localStorageKeys[0].key, // watchlist key named
    STORAGE_FACTS.localStorageKeys[1].key, // notice-ack key named
    'HttpOnly', // cookie attributes
    'SameSite=Strict',
  ];
  for (const fact of required) {
    assert.ok(html.includes(fact), `privacy page states: "${fact}"`);
  }
  assert.ok(
    html.includes('Self-service account deletion is not currently offered'),
    'the absence of self-service deletion is stated truthfully',
  );
});

test('cookies page carries the complete, accurate storage inventory', () => {
  const html = renderToStaticMarkup(React.createElement(CookiesPage));
  assert.ok(html.includes('ve_session'), 'names the session cookie');
  assert.ok(
    html.includes('HttpOnly, SameSite=Strict, path /, Secure in production'),
    'cookie attributes verbatim',
  );
  for (const entry of STORAGE_FACTS.localStorageKeys) {
    assert.ok(html.includes(entry.key), `inventory lists ${entry.key}`);
    assert.ok(html.includes(entry.purpose), `inventory explains ${entry.key}`);
  }
  for (const claim of STORAGE_FACTS.notUsed) {
    assert.ok(html.includes(claim), `cookies page states: "${claim}"`);
  }
  assert.ok(html.includes('the only cookie'), 'inventory pins the single cookie');
});

test('the storage inventory is complete: every browser-storage key in apps/web is declared', () => {
  const declared = new Set<string>([
    STORAGE_FACTS.localStorageKeys[0].key,
    STORAGE_FACTS.localStorageKeys[1].key,
  ]);

  const sourceFiles: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = `${dir}/${entry}`;
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) sourceFiles.push(full);
    }
  };
  walk(srcPath('..')); // apps/web (app, components, lib, …)

  const keyLiteral = /['"`](veltrixeye:[a-z0-9:._-]+)['"`]/g;
  const seen = new Set<string>();
  for (const file of sourceFiles) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes('localStorage') && !source.includes('STORAGE_KEY')) continue;
    for (const match of source.matchAll(keyLiteral)) seen.add(match[1]);
  }
  for (const key of seen) {
    assert.ok(declared.has(key), `browser-storage key "${key}" must be declared in STORAGE_FACTS`);
  }
  assert.ok(seen.has('veltrixeye:watchlist'), 'watchlist storage is inventoried');
  assert.ok(seen.has(COOKIE_NOTICE_ACK_KEY), 'notice acknowledgement storage is inventoried');
  assert.equal(
    COOKIE_NOTICE_ACK_KEY,
    STORAGE_FACTS.localStorageKeys[1].key,
    'notice key matches the inventory entry',
  );
});

/* ------------------------------------------------------------------ */
/* 5. Cookie notice: accurate claims, bounded consent behavior         */
/* ------------------------------------------------------------------ */

test('the cookie notice states only verified facts and links to the cookies page', () => {
  const html = renderToStaticMarkup(React.createElement(CookieNoticeBanner, { onDismiss: () => {} }));
  assert.ok(html.includes(COOKIE_NOTICE.body), 'notice body rendered');
  assert.ok(html.includes('strictly necessary session cookie'), 'claims the session cookie only');
  assert.ok(html.includes('No advertising or third-party tracking cookies'), 'denies tracking cookies');
  assert.ok(html.includes(`href="${COOKIE_NOTICE.learnMoreHref}"`), 'links to /legal/cookies');
  assert.ok(html.includes(COOKIE_NOTICE.dismissLabel), 'has a dismiss control');
  assert.ok(html.includes('data-cookie-notice="true"'), 'machine-readable notice marker');
});

test('the notice touches only its own acknowledgement key and never document.cookie', () => {
  const source = code('../components/cookie-notice.tsx');
  assert.ok(!source.includes('document.cookie'), 'no direct cookie writes');
  assert.ok(!source.includes('fetch('), 'no network calls');
  assert.ok(!source.includes('http://') && !source.includes('https://'), 'no external URLs');
  const storageCalls = [...source.matchAll(/localStorage\.(getItem|setItem|removeItem)\(([^)]*)\)/g)];
  assert.equal(storageCalls.length, 2, 'exactly one read and one write of storage');
  for (const call of storageCalls) {
    assert.ok(call[2].includes('COOKIE_NOTICE_ACK_KEY'), `storage call uses the declared key: ${call[0]}`);
  }
});

/* ------------------------------------------------------------------ */
/* 6. No external tracking anywhere in the touched surface             */
/* ------------------------------------------------------------------ */

test('no external script, CDN, or tracker is introduced by this slice', () => {
  const touched = [
    ...PAGE_FILES,
    '../components/legal.tsx',
    '../components/cookie-notice.tsx',
    '../lib/legal-copy.ts',
    '../app/layout.tsx',
    '../app/page.tsx',
    '../app/login/page.tsx',
    '../app/register/page.tsx',
    '../components/app-shell.tsx',
  ];
  for (const rel of touched) {
    const source = code(rel);
    for (const tracker of [
      'googletagmanager',
      'google-analytics',
      'gtag(',
      'doubleclick',
      'connect.facebook',
      'cdn.',
      '<script src=',
    ]) {
      assert.ok(!source.includes(tracker), `${rel} contains no tracker/CDN (${tracker})`);
    }
  }
});

test('the root layout mounts the notice exactly once and keeps AuthProvider', () => {
  const layout = src('../app/layout.tsx');
  const mounts = layout.split('<CookieNotice />').length - 1;
  assert.equal(mounts, 1, 'CookieNotice mounted once');
  assert.ok(layout.includes('<AuthProvider>'), 'auth provider unchanged');
});
