'use client';

import * as React from 'react';

/** Minimal design-system primitives (no external UI dependency). */

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
}) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-500 disabled:opacity-50 disabled:pointer-events-none';
  const variants: Record<string, string> = {
    primary: 'bg-signal-600 text-white hover:bg-signal-500',
    secondary: 'bg-ink-700 text-ink-100 hover:bg-ink-600 border border-ink-600',
    ghost: 'text-ink-300 hover:text-ink-100 hover:bg-ink-750',
    danger: 'bg-danger-450/15 text-danger-450 border border-danger-450/40 hover:bg-danger-450/25',
  };
  return <button className={`${base} ${variants[variant]} ${className}`} {...props} />;
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-ink-300">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-ink-400">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-danger-450">{error}</span>}
    </label>
  );
}

export function Input({ className = '', ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-md border border-ink-600 bg-ink-850 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-400 focus:border-signal-500 focus:outline-none focus:ring-1 focus:ring-signal-500/50 ${className}`}
      {...props}
    />
  );
}

export function TextArea({ className = '', ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`w-full rounded-md border border-ink-600 bg-ink-850 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-400 focus:border-signal-500 focus:outline-none focus:ring-1 focus:ring-signal-500/50 ${className}`}
      {...props}
    />
  );
}

export function Select({ className = '', children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`w-full appearance-none rounded-md border border-ink-600 bg-ink-850 px-3 py-2 text-sm text-ink-100 focus:border-signal-500 focus:outline-none focus:ring-1 focus:ring-signal-500/50 ${className}`}
      {...props}
    >
      {children}
    </select>
  );
}

export function Card({ className = '', children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={`rounded-lg border border-ink-700 bg-ink-800 ${className}`}>{children}</div>
  );
}

export function CardHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-ink-700 px-5 py-4">
      <div>
        <h2 className="text-sm font-semibold text-ink-50">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-ink-400">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

const badgeTones: Record<string, string> = {
  neutral: 'bg-ink-700/60 text-ink-200 border-ink-600',
  success: 'bg-signal-500/10 text-signal-400 border-signal-500/30',
  warning: 'bg-amber-450/10 text-amber-450 border-amber-450/30',
  danger: 'bg-danger-450/10 text-danger-450 border-danger-450/30',
  info: 'bg-info-450/10 text-info-450 border-info-450/30',
};

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: keyof typeof badgeTones;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide ${badgeTones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Spinner() {
  return (
    <div className="flex items-center justify-center py-16">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-ink-600 border-t-signal-500" />
    </div>
  );
}

export function Alert({
  tone = 'danger',
  title,
  children,
}: {
  tone?: 'danger' | 'info' | 'success' | 'warning';
  /** Optional bold lead-in (rendered as a heading for screen readers). */
  title?: string;
  children: React.ReactNode;
}) {
  const tones = {
    danger: 'border-danger-450/40 bg-danger-450/10 text-danger-450',
    info: 'border-info-450/40 bg-info-450/10 text-info-450',
    success: 'border-signal-500/40 bg-signal-500/10 text-signal-400',
    warning: 'border-amber-450/40 bg-amber-450/10 text-amber-450',
  };
  return (
    <div className={`rounded-md border px-3 py-2.5 text-sm ${tones[tone]}`}>
      {title && <h3 className="mb-0.5 text-sm font-semibold">{title}</h3>}
      {children}
    </div>
  );
}

export function Monospace({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-[13px] tracking-tight">{children}</span>;
}
