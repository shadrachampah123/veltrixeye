/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Compile workspace TS source directly.
  transpilePackages: ['@veltrixeye/contracts'],
  webpack: (config) => {
    // Workspace packages use NodeNext-style `.js` import specifiers that
    // point at `.ts` sources; tell webpack to try `.ts` first.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    };
    return config;
  },
  async rewrites() {
    // Same-origin /api proxy → the API service (server-side; the browser
    // never talks to another host, so no CORS and cookies work normally).
    const apiBase = process.env.API_INTERNAL_BASE || 'http://127.0.0.1:4000';
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
