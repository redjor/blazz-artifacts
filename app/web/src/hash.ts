// Shareable state in the hash: #project=x&a=<id>. replaceState: no history entry per click.
export function readHash(key: 'project' | 'a'): string | null {
  return new URLSearchParams(window.location.hash.slice(1)).get(key) || null;
}

export function writeHash(update: Partial<Record<'project' | 'a', string | null>>): void {
  const params = new URLSearchParams(window.location.hash.slice(1));
  for (const [k, v] of Object.entries(update)) {
    if (v) params.set(k, v);
    else params.delete(k);
  }
  const s = params.toString();
  history.replaceState(null, '', s ? `#${s}` : window.location.pathname + window.location.search);
}
