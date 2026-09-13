/**
 * Resolve the server-side API base URL for the same-origin `/api/*` rewrite.
 *
 * The browser only ever calls same-origin `/api/...`; this URL is used by the
 * Next.js server (at build time, when the rewrite is compiled in) and is never
 * sent to the client — do not rename it to `NEXT_PUBLIC_*`.
 *
 *  - local development: `apps/web/.env.local` (created by `npm run setup`)
 *    points at the dev API on http://127.0.0.1:4000.
 *  - production (Vercel): set `API_INTERNAL_BASE` to the deployed API's HTTPS
 *    origin, e.g. `https://<your-api-host>`. See docs/deployment.md.
 *
 * Failing fast matters here: the rewrite destination is baked into the build,
 * so a production build without this variable would silently proxy to
 * localhost and every API call in production would fail. Vercel keeps serving
 * the previous deployment when a build fails, so throwing is the safe failure.
 */
function resolveApiBase() {
  const configured = (process.env.API_INTERNAL_BASE ?? '').trim().replace(/\/+$/, '');
  const onVercelProduction = process.env.VERCEL_ENV === 'production';

  if (configured !== '') {
    if (!/^https?:\/\//i.test(configured)) {
      throw new Error(
        `API_INTERNAL_BASE must be an absolute URL (got "${configured}"). ` +
          'Example: https://your-api-host. See docs/environment.md.',
      );
    }
    if (onVercelProduction && !configured.startsWith('https://')) {
      throw new Error(
        `API_INTERNAL_BASE must use https:// in production (got "${configured}"). ` +
          'Session cookies and credentials must never cross the network in plaintext. ' +
          'See docs/deployment.md.',
      );
    }
    return configured;
  }

  if (onVercelProduction) {
    throw new Error(
      'API_INTERNAL_BASE is not set for this production build.\n' +
        'Set it to the deployed API origin (https://<your-api-host>) in the Vercel ' +
        'project, then redeploy. See docs/deployment.md.',
    );
  }

  console.warn(
    '[veltrixeye] API_INTERNAL_BASE is not set — proxying /api/* to http://127.0.0.1:4000 ' +
      '(local development only). See docs/environment.md.',
  );
  return 'http://127.0.0.1:4000';
}

const apiBase = resolveApiBase();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Compile workspace TS source directly.
  transpilePackages: ['@veltrixeye/contracts'],
  webpack: (webpackConfig) => {
    // Workspace packages use NodeNext-style `.js` import specifiers that
    // point at `.ts` sources; tell webpack to try `.ts` first.
    webpackConfig.resolve.extensionAlias = {
      ...webpackConfig.resolve.extensionAlias,
      '.js': ['.ts', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    };
    return webpackConfig;
  },
  async rewrites() {
    // Same-origin /api proxy → the API service (server-side; the browser
    // never talks to another host, so no CORS and cookies work normally).
    return [
      {
        source: '/api/:path*',
        destination: `${apiBase}/api/:path*`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default config;
