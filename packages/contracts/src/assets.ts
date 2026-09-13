import { z } from 'zod';

/**
 * Normalized market model.
 *
 * Strategy logic ALWAYS references instruments through this normalized
 * representation (asset class + canonical symbol). Provider-specific
 * ticker strings are stored only in the mapping table
 * `instrument_provider_symbols` and must never leak into strategy
 * configuration. See docs/provider-abstraction.md.
 */
export const ASSET_CLASSES = [
  'forex',
  'commodity',
  'index',
  'crypto',
  'stock',
  'etf',
  'other',
] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  forex: 'Forex',
  commodity: 'Commodities',
  index: 'Indices',
  crypto: 'Crypto',
  stock: 'Stocks',
  etf: 'ETFs',
  other: 'Other',
};

export const assetClassSchema = z.enum(ASSET_CLASSES);

/**
 * Canonical, provider-independent instrument symbol rules.
 * Input may be any case; it is normalized to UPPERCASE on the way in.
 */
export const instrumentSymbolSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/, 'Symbol must be letters/digits with . _ : - allowed')
  .transform((s) => s.toUpperCase());

export const normalizedInstrumentSchema = z
  .object({
    assetClass: assetClassSchema,
    symbol: instrumentSymbolSchema.transform((s) => s.toUpperCase()),
    displayName: z.string().trim().min(1).max(80).optional(),
  })
  .strict();
export type NormalizedInstrument = z.infer<typeof normalizedInstrumentSchema>;

/** Scope of a strategy version across markets. */
export const marketScopeSchema = z
  .object({
    mode: z.enum(['all', 'instruments']),
    /** Required (min 1) when mode === 'instruments'. */
    instruments: z.array(normalizedInstrumentSchema).min(1).optional(),
  })
  .strict()
  .superRefine((scope, ctx) => {
    if (scope.mode === 'instruments' && (!scope.instruments || scope.instruments.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['instruments'],
        message: 'At least one instrument is required when scope mode is "instruments"',
      });
    }
    if (scope.mode === 'all' && scope.instruments) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['instruments'],
        message: 'instruments must not be provided when scope mode is "all"',
      });
    }
  });
export type MarketScope = z.infer<typeof marketScopeSchema>;
