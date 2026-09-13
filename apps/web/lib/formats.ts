export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function timeframesLabel(timeframes: { htf_bias: string; setup: string; entry: string } | null | undefined): string {
  if (!timeframes) return 'not set';
  return `${timeframes.htf_bias.toUpperCase()} bias · ${timeframes.setup.toUpperCase()} setup · ${timeframes.entry.toUpperCase()} entry`;
}
