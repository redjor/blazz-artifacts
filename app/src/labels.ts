// Folders (projects) and tags: internal organisation. Only the name of a folder shared as a page shows on the content server (/d/<folder>).
// Same rules in web/src/format.ts and cli/publish-artifact/publish.py.
export const MAX_LABEL_LENGTH = 32;
export const MAX_TAGS = 20;

/** Normalises a label; null when the result is empty. */
export function normalizeLabel(input: string): string | null {
  const s = input
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_LABEL_LENGTH)
    .replace(/-+$/, '');
  return s || null;
}

/** Normalises a set of tags (duplicates merged, sorted); null when one is invalid or there are too many. */
export function normalizeTags(inputs: string[]): string[] | null {
  const out = new Set<string>();
  for (const raw of inputs) {
    const t = normalizeLabel(raw);
    if (t === null) return null;
    out.add(t);
  }
  if (out.size > MAX_TAGS) return null;
  return [...out].sort();
}
