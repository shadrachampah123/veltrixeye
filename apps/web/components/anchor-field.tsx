'use client';

import * as React from 'react';
import { Input } from '@/components/ui';
import { ANCHOR_HELP, anchorReadout, parseAnchorValue } from '@/lib/workbench';

/**
 * The explicit deterministic anchor control (M7.1).
 *
 * Every M3/M4/M5 call the browser makes is pinned to this instant, and the
 * engines never read the clock — detection and transitions REQUIRE the caller's
 * anchor, and evaluation only falls back to the API clock when `asOf` is
 * omitted, which this UI never does. The exact epoch-ms value that will be sent
 * is rendered under the field so the anchor is never implicit: what you read is
 * what the request carries.
 */
export interface AnchorFieldProps {
  /** `datetime-local` value in the browser's local time. */
  value: string;
  onChange: (value: string) => void;
  /** Fill the field with the current minute (the only wall-clock read in the UI). */
  onUseNow: () => void;
  disabled?: boolean;
  error?: string | null;
  label?: string;
  id?: string;
}

export function AnchorField({
  value,
  onChange,
  onUseNow,
  disabled = false,
  error = null,
  label = 'Anchor (date & time)',
  id = 'anchor',
}: AnchorFieldProps) {
  const ms = parseAnchorValue(value);
  const helpId = `${id}-help`;

  return (
    <div>
      <label htmlFor={id} className="block">
        <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-ink-300">{label}</span>
        <Input
          id={id}
          type="datetime-local"
          step={60}
          value={value}
          disabled={disabled}
          aria-describedby={helpId}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          className="text-xs text-ink-300 underline underline-offset-2 hover:text-ink-100 disabled:opacity-50"
          disabled={disabled}
          onClick={onUseNow}
        >
          Use current time
        </button>
        {ms !== null && (
          <span className="font-mono text-xs text-ink-400" data-testid="anchor-readout">
            {anchorReadout(ms)}
          </span>
        )}
      </div>
      {error ? (
        <p id={helpId} role="alert" className="mt-1 text-xs text-danger-450">
          {error}
        </p>
      ) : (
        <p id={helpId} className="mt-1 text-xs text-ink-500">
          {ANCHOR_HELP}
        </p>
      )}
    </div>
  );
}
