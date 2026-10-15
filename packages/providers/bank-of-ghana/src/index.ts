/**
 * `@veltrixeye/provider-bank-of-ghana` — the READ-ONLY Bank of Ghana FX source
 * reader.
 *
 * Scope, in one line: read the Bank of Ghana's published daily interbank FX
 * rates page once, locate the USD→GHS row deterministically, and hand its raw
 * figures upward. Everything else — validation, recording, deduplication,
 * staleness and any decision about a rate — belongs to `@veltrixeye/core`, and
 * publishing an authoritative rate version belongs to a separate, approved
 * operator operation that nothing in this package can reach.
 *
 * The package deliberately has NO dependency on `@veltrixeye/core`: transport
 * cannot call the pricing authority, and the pricing authority cannot fetch.
 */

export * from './client.js';
export * from './parse.js';
export * from './source.js';
