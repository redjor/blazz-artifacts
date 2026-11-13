import { CodedError } from '../errors.ts';
import { escapeHtml } from './page.ts';

export class JsonRejected extends CodedError {}

export function renderJson(text: string): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new JsonRejected('invalid_json', { detail: (e as Error).message });
  }
  return `<pre><code>${escapeHtml(JSON.stringify(value, null, 2))}</code></pre>`;
}
