/**
 * CL-1 — the single, reviewable source of customer-facing legal copy.
 *
 * STATUS: EVERY STRING IN THIS MODULE IS A DRAFT. It has NOT been reviewed or
 * approved by counsel and must not be represented as counsel-approved. The
 * pages that render this copy display the review banner (LEGAL_COPY_STATUS)
 * so no surface can present it as final.
 *
 * Rules for this file (enforced by tests in test/legal-pages.test.ts):
 *  - Facts stated here must match VERIFIED product behavior (cookies, storage,
 *    what the platform records, what it never stores). Do not add a claim that
 *    is not true of the code today.
 *  - Anything that needs operator or counsel judgment — legal entity name,
 *    registered address, governing law, general retention periods, refund
 *    policy, eligibility age, liability wording — is a bracketed
 *    LEGAL_PLACEHOLDERS entry and must stay marked until approved.
 *  - Never invent a company address, jurisdiction, retention period, cookie,
 *    or compliance certification (e.g. no "GDPR compliant" claims).
 */

export const LEGAL_COPY_STATUS = {
  approved: false,
  label: 'DRAFT — pending operator and counsel review',
  note:
    'This document is a working draft prepared for operator and counsel review. ' +
    'It is not counsel-approved and is not final. Bracketed items require operator ' +
    'input before publication.',
} as const;

/** Items that only the operator/counsel may fill in. Never guess these. */
export const LEGAL_PLACEHOLDERS = {
  legalEntityName: '[OPERATOR TO CONFIRM: legal entity name]',
  registeredAddress: '[OPERATOR TO CONFIRM: registered address]',
  governingLaw: '[OPERATOR TO CONFIRM: governing law and jurisdiction]',
  eligibilityAge: '[OPERATOR TO CONFIRM: minimum age / eligibility requirements]',
  liabilityWording: '[OPERATOR TO CONFIRM: liability limitation, drafted by counsel]',
  refundPolicy: '[OPERATOR TO CONFIRM: refund and cancellation policy]',
  generalRetention: '[OPERATOR TO CONFIRM: general data-retention period]',
  deletionProcess: '[OPERATOR TO CONFIRM: account and data deletion process]',
  privacyRights: '[OPERATOR TO CONFIRM: privacy-rights wording for the governing jurisdiction]',
  termsChangeNotice: '[OPERATOR TO CONFIRM: how changes to these terms are announced]',
} as const;

/**
 * Pinned risk strings. These exact sentences are asserted by tests and must
 * appear on the risk page. They mirror the product's own safety language
 * ("alerts remain suggestions, never orders"; "paper results are simulations,
 * not broker fills").
 */
export const RISK_DISCLAIMERS = [
  'VeltrixEye provides information and analysis tools only and does not provide investment advice.',
  'Trading alerts are suggestions, never orders.',
  'Trading involves substantial risk of loss.',
  'Past performance is not indicative of future results.',
  'Paper simulation results are not broker fills and are not a guarantee of future performance.',
] as const;

/** Pinned cookie-notice strings, asserted by tests. */
export const COOKIE_NOTICE = {
  headline: 'Cookies & local storage',
  body:
    'This site uses one strictly necessary session cookie to keep you signed in, ' +
    'and stores your watchlist and this notice’s dismissal in your browser’s local ' +
    'storage. No advertising or third-party tracking cookies.',
  learnMoreLabel: 'Learn more',
  learnMoreHref: '/legal/cookies',
  dismissLabel: 'Dismiss',
} as const;

/**
 * Storage facts — the complete, verified inventory. The cookies page and the
 * notice render ONLY from this list, so a new storage key must be added here
 * (and the tests will force the page text to stay accurate).
 */
export const STORAGE_FACTS = {
  sessionCookie: {
    name: 've_session',
    purpose: 'Keeps you signed in (server-validated session token).',
    attributes: 'HttpOnly, SameSite=Strict, path /, Secure in production',
    duration:
      'Expires with your session lifetime (30 days by default; the operator can configure 1–90 days) and is cleared on sign-out or password change.',
    note: 'The server stores only a SHA-256 hash of the token, never the token itself.',
  },
  localStorageKeys: [
    {
      key: 'veltrixeye:watchlist',
      purpose: 'Stores the watchlist you build in the Markets workspace, in your browser only.',
    },
    {
      key: 'veltrixeye:cookie-notice.ack',
      purpose: 'Remembers that you dismissed the cookie notice, in your browser only.',
    },
  ],
  pushSubscription:
    'Only if you turn on push notifications in Settings: your browser’s push ' +
    'subscription (an endpoint URL and two encryption keys) is stored server-side ' +
    'and encrypted at rest. You can turn it off at any time.',
  notUsed: [
    'No advertising cookies.',
    'No third-party analytics or tracking scripts.',
    'No cross-site tracking pixels.',
    'No other cookies — the session cookie above is the only one.',
  ],
} as const;

export interface LegalSection {
  id: string;
  heading: string;
  paragraphs: string[];
}

export interface LegalPageCopy {
  href: string;
  title: string;
  summary: string;
  sections: LegalSection[];
}

export const LEGAL_NAV: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/legal/terms', label: 'Terms of Use' },
  { href: '/legal/privacy', label: 'Privacy' },
  { href: '/legal/risk', label: 'Risk Disclosure' },
  { href: '/legal/cookies', label: 'Cookies' },
];

const SUPPORT_EMAIL = 'support@veltrixeye.com';

export const TERMS_COPY: LegalPageCopy = {
  href: '/legal/terms',
  title: 'Terms of Use',
  summary: `Working draft of the terms governing access to VeltrixEye. ${LEGAL_COPY_STATUS.note}`,
  sections: [
    {
      id: 'status',
      heading: 'Status of this document',
      paragraphs: [
        `This is a DRAFT prepared for review. ${LEGAL_COPY_STATUS.note} ${LEGAL_PLACEHOLDERS.legalEntityName} is the entity that will be identified as the operator of VeltrixEye once confirmed.`,
      ],
    },
    {
      id: 'service',
      heading: 'The service',
      paragraphs: [
        'VeltrixEye is software that lets you define your own deterministic trading strategies, evaluate them against historical and recent market data, run backtests, receive quality-scored setup alerts, and observe an internal paper (simulated) execution environment.',
        'VeltrixEye is not a broker, does not hold funds or positions for you, and does not execute trades. Any execution environment shown in the product is a simulation. No live or demo broker account is connected.',
      ],
    },
    {
      id: 'no-advice',
      heading: 'No investment advice',
      paragraphs: [
        RISK_DISCLAIMERS[0],
        'Nothing in the product — alerts, scores, backtests, or paper results — is a recommendation to buy or sell any instrument. See the Risk Disclosure for the full statement.',
      ],
    },
    {
      id: 'accounts',
      heading: 'Your account',
      paragraphs: [
        `You must provide accurate registration information and keep your credentials confidential; you are responsible for activity under your account. ${LEGAL_PLACEHOLDERS.eligibilityAge}`,
      ],
    },
    {
      id: 'acceptable-use',
      heading: 'Acceptable use',
      paragraphs: [
        'Use VeltrixEye only for lawful purposes. Do not attempt to probe, overload, scrape, or circumvent the platform’s security or rate limits, resell access, or use the service to violate applicable law or third-party rights.',
      ],
    },
    {
      id: 'billing',
      heading: 'Subscriptions and billing',
      paragraphs: [
        'Paid plans, where offered, are billed through the payment provider named at checkout. Prices shown in the product are the authoritative prices. Plan entitlements are enforced server-side.',
        `${LEGAL_PLACEHOLDERS.refundPolicy} Cancellation and invoice options, where offered, are described in the billing screens; some actions may currently be handled by support rather than self-service.`,
      ],
    },
    {
      id: 'market-data',
      heading: 'Market data',
      paragraphs: [
        'Market data is supplied by third-party providers and displayed for your use within the product. Redistribution, republication, or bulk export of raw market data is not permitted.',
      ],
    },
    {
      id: 'your-content',
      heading: 'Your strategies and content',
      paragraphs: [
        'The strategies, configurations, and notes you create remain yours. You grant the platform only the rights needed to operate the service (for example, evaluating your strategy to generate setups and alerts).',
        `${LEGAL_PLACEHOLDERS.liabilityWording}`,
      ],
    },
    {
      id: 'availability',
      heading: 'Availability and warranties',
      paragraphs: [
        'The service is provided “as is” and “as available”. Market data can be delayed, incomplete, or wrong; scheduled work can be interrupted by hosting or provider outages. No uptime, accuracy, or profit outcome is promised.',
      ],
    },
    {
      id: 'termination',
      heading: 'Suspension and termination',
      paragraphs: [
        'Access may be suspended or terminated for misuse or legal risk. You may stop using the service at any time; ' +
          `${LEGAL_PLACEHOLDERS.deletionProcess} (self-service account deletion is not currently offered).`,
      ],
    },
    {
      id: 'changes',
      heading: 'Changes to these terms',
      paragraphs: [
        `These terms may change as the product and law evolve. ${LEGAL_PLACEHOLDERS.termsChangeNotice} Continued use after a change takes effect constitutes acceptance of the revised terms.`,
      ],
    },
    {
      id: 'law',
      heading: 'Governing law and contact',
      paragraphs: [
        `${LEGAL_PLACEHOLDERS.governingLaw} Registered contact: ${LEGAL_PLACEHOLDERS.legalEntityName}, ${LEGAL_PLACEHOLDERS.registeredAddress}. Questions about these terms: ${SUPPORT_EMAIL}.`,
      ],
    },
  ],
};

export const PRIVACY_COPY: LegalPageCopy = {
  href: '/legal/privacy',
  title: 'Privacy Notice',
  summary: `Working draft of how VeltrixEye handles personal data. Every fact below reflects the platform’s current, verified behavior; items in brackets await operator and counsel input. ${LEGAL_COPY_STATUS.note}`,
  sections: [
    {
      id: 'status',
      heading: 'Status of this document',
      paragraphs: [LEGAL_COPY_STATUS.note],
    },
    {
      id: 'who',
      heading: 'Who is responsible',
      paragraphs: [
        `${LEGAL_PLACEHOLDERS.legalEntityName} will be identified as the data controller once the operator confirms it. Contact: ${SUPPORT_EMAIL}.`,
      ],
    },
    {
      id: 'collect',
      heading: 'What the platform records (verified)',
      paragraphs: [
        'Account: your email, an optional display name, and your password — stored only as an argon2id password hash, never in plain text.',
        'Sessions: a server-side session record containing a SHA-256 hash of the session token (the token itself lives only in your browser cookie), your IP address, and timestamps. Expired sessions are cleaned up at service start.',
        'Audit log: an append-only security log of events (registration, sign-in, failed sign-in, sign-out, password change, and strategy-lifecycle actions) recording the time, your IP address, and browser user-agent string.',
        'Your content: strategies, versions, conditions, setups, quality scores, backtests, alerts, and notification preferences that you create.',
        'Notification deliveries: for alerts you receive, the platform stores the recipient email, the rendered message, and each delivery attempt’s outcome (documented retention defaults: delivered rows 30 days, failed rows 120 days).',
        'Billing (only if you purchase a plan): subscription state, the payment provider’s customer/subscription identifiers, and verified payment evidence (provider reference, amount, currency, timestamps). Card and bank details are collected by the payment provider and are never stored by VeltrixEye.',
        'Push notifications (only if you enable them): your browser’s push subscription (endpoint URL and two encryption keys), encrypted at rest server-side.',
        'Server logs: operational request logs carry identifiers, statuses and error categories — message payloads and credentials are excluded by design.',
      ],
    },
    {
      id: 'not-collect',
      heading: 'What is not collected',
      paragraphs: [
        'No advertising identifiers and no third-party analytics or tracking scripts run on this site.',
        'No precise location; IP addresses are used for security, rate limiting and audit attribution only.',
        'No card, authorization, or bank details are stored by the platform.',
      ],
    },
    {
      id: 'cookies',
      heading: 'Cookies and local storage',
      paragraphs: [
        `One strictly necessary session cookie (HttpOnly, SameSite=Strict, Secure in production) keeps you signed in. Your watchlist is stored in your browser’s local storage under ${STORAGE_FACTS.localStorageKeys[0].key}, and the cookie-notice dismissal under ${STORAGE_FACTS.localStorageKeys[1].key}. Details: the Cookies page.`,
      ],
    },
    {
      id: 'use',
      heading: 'How information is used',
      paragraphs: [
        'To operate and secure the product: authenticate you, enforce plan limits server-side, evaluate your strategies, generate and deliver alerts, produce backtests and simulated execution records, process subscriptions, prevent abuse, and maintain the audit trail.',
      ],
    },
    {
      id: 'sharing',
      heading: 'Who else receives data',
      paragraphs: [
        'Service providers needed to run the product: the hosting platform, the market-data provider, the payment provider (for checkout and payment verification), and the email/push/webhook delivery channels you configure. ' +
          `${LEGAL_PLACEHOLDERS.privacyRights} A complete processor list is maintained by the operator: [OPERATOR TO CONFIRM: processor list and data-processing terms].`,
      ],
    },
    {
      id: 'retention',
      heading: 'Retention',
      paragraphs: [
        'Verified specifics: notification delivery records keep delivered rows 30 days and failed rows 120 days; expired sessions are removed at service start. ' +
          `All other data is kept for as long as the account is active and as required to operate the service: ${LEGAL_PLACEHOLDERS.generalRetention}. Self-service account deletion is not currently offered; deletion requests: ${LEGAL_PLACEHOLDERS.deletionProcess}.`,
      ],
    },
    {
      id: 'security',
      heading: 'Security',
      paragraphs: [
        'Passwords are hashed with argon2id; session tokens are stored hashed; session cookies are HttpOnly and SameSite=Strict and Secure in production; notification secrets and push keys are encrypted at rest with authenticated encryption. No system is perfectly secure, and no guarantee of absolute security is made.',
      ],
    },
    {
      id: 'rights',
      heading: 'Your rights',
      paragraphs: [
        `${LEGAL_PLACEHOLDERS.privacyRights} To exercise any right or ask a question, contact ${SUPPORT_EMAIL}.`,
      ],
    },
    {
      id: 'changes',
      heading: 'Changes and contact',
      paragraphs: [
        `This notice may change with the product or the law. ${LEGAL_PLACEHOLDERS.termsChangeNotice} Contact: ${SUPPORT_EMAIL}.`,
      ],
    },
  ],
};

export const RISK_COPY: LegalPageCopy = {
  href: '/legal/risk',
  title: 'Risk Disclosure',
  summary: `Working draft of the risk disclosures for a trading-signal product. ${LEGAL_COPY_STATUS.note}`,
  sections: [
    {
      id: 'status',
      heading: 'Status of this document',
      paragraphs: [LEGAL_COPY_STATUS.note],
    },
    {
      id: 'core',
      heading: 'Core disclosures',
      paragraphs: [...RISK_DISCLAIMERS],
    },
    {
      id: 'no-broker',
      heading: 'No brokerage, no execution',
      paragraphs: [
        'VeltrixEye is not a broker and holds no funds or positions. Nothing in the product places an order with any broker or exchange. The trading view is an internal paper (simulated) environment fed by the platform’s own stored market data; its fills, prices, and profit figures are simulated.',
        'Automation of live trading is not available in this product and is switched off by design.',
      ],
    },
    {
      id: 'signals',
      heading: 'About the signals',
      paragraphs: [
        'Strategies are deterministic rule sets that you configure; the platform evaluates them mechanically. Mechanical evaluation removes human bias from the check itself — it does not make the future predictable. Markets can gap through stops, spreads and slippage can exceed assumptions, and liquidity can vanish.',
        'Quality scores and grades are heuristics defined by the product’s scoring rules. They are not predictions and not guarantees.',
      ],
    },
    {
      id: 'backtests',
      heading: 'Backtests and hypothetical results',
      paragraphs: [
        'Backtest results are hypothetical, are produced from historical data with simplified cost and fill assumptions, and suffer from hindsight and selection effects. Hypothetical performance has inherent limitations and does not reflect the impact of real trading frictions.',
      ],
    },
    {
      id: 'data',
      heading: 'Market data risks',
      paragraphs: [
        'Market data comes from third parties and can be delayed, incomplete, corrected, or wrong. The platform rejects stale or invalid data where it detects it, but no data pipeline is infallible, and a provider outage can interrupt analysis and alerts entirely.',
      ],
    },
    {
      id: 'responsibility',
      heading: 'Your responsibility',
      paragraphs: [
        'You alone decide whether and how to trade. Consider your financial situation, experience, and risk tolerance, and seek independent, licensed advice where appropriate. Never trade money you cannot afford to lose.',
        `${LEGAL_PLACEHOLDERS.governingLaw} This disclosure is not tailored investment advice and does not take account of your circumstances.`,
      ],
    },
  ],
};

export const COOKIES_COPY: LegalPageCopy = {
  href: '/legal/cookies',
  title: 'Cookies & Local Storage',
  summary: `Working draft of the cookie and browser-storage disclosure. The inventory below lists everything the product actually stores in your browser today — nothing else. ${LEGAL_COPY_STATUS.note}`,
  sections: [
    {
      id: 'status',
      heading: 'Status of this document',
      paragraphs: [LEGAL_COPY_STATUS.note],
    },
    {
      id: 'what',
      heading: 'What cookies are',
      paragraphs: [
        'Cookies are small text files a site asks your browser to store and send back on later requests. Local storage is a browser feature that keeps small values on your device only. This page lists both, because the product uses one of each.',
      ],
    },
    {
      id: 'inventory',
      heading: 'The complete inventory',
      paragraphs: [
        `Cookie — ${STORAGE_FACTS.sessionCookie.name} (the only cookie): ${STORAGE_FACTS.sessionCookie.purpose} Attributes: ${STORAGE_FACTS.sessionCookie.attributes}. ${STORAGE_FACTS.sessionCookie.duration} ${STORAGE_FACTS.sessionCookie.note}`,
        `Local storage — ${STORAGE_FACTS.localStorageKeys[0].key}: ${STORAGE_FACTS.localStorageKeys[0].purpose}`,
        `Local storage — ${STORAGE_FACTS.localStorageKeys[1].key}: ${STORAGE_FACTS.localStorageKeys[1].purpose}`,
        `Service worker & push (optional): ${STORAGE_FACTS.pushSubscription}`,
      ],
    },
    {
      id: 'not-used',
      heading: 'What is not used',
      paragraphs: [...STORAGE_FACTS.notUsed],
    },
    {
      id: 'manage',
      heading: 'Managing cookies and storage',
      paragraphs: [
        'Your browser can block or delete cookies and clear site data. Blocking or deleting the session cookie will sign you out and prevent signing in until it is allowed again. The watchlist and the cookie-notice dismissal are cleared by clearing site data for this site in your browser settings.',
        'The cookie notice is informational — it does not gate any feature — and it is the only consent the product asks for: dismissing it stores the acknowledgement key listed above.',
      ],
    },
    {
      id: 'contact',
      heading: 'Changes and contact',
      paragraphs: [
        `If the product ever stores something new in your browser, this inventory and the tests pinning it will be updated in the same change. ${LEGAL_PLACEHOLDERS.termsChangeNotice} Contact: ${SUPPORT_EMAIL}.`,
      ],
    },
  ],
};

export const LEGAL_PAGES: Record<string, LegalPageCopy> = {
  terms: TERMS_COPY,
  privacy: PRIVACY_COPY,
  risk: RISK_COPY,
  cookies: COOKIES_COPY,
};
