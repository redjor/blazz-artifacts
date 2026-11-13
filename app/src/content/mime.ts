const TEXT = (t: string) => `${t}; charset=utf-8`;
const TYPES = new Map<string, string>([
  ['html', TEXT('text/html')], ['htm', TEXT('text/html')], ['css', TEXT('text/css')],
  ['js', TEXT('text/javascript')], ['mjs', TEXT('text/javascript')], ['json', TEXT('application/json')],
  ['svg', 'image/svg+xml'], ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'], ['webp', 'image/webp'], ['avif', 'image/avif'], ['ico', 'image/x-icon'],
  ['woff', 'font/woff'], ['woff2', 'font/woff2'], ['ttf', 'font/ttf'], ['otf', 'font/otf'],
  ['txt', TEXT('text/plain')], ['md', TEXT('text/plain')], ['pdf', 'application/pdf'],
  ['mp3', 'audio/mpeg'], ['mp4', 'video/mp4'], ['webm', 'video/webm'], ['wasm', 'application/wasm'],
]);

export function contentTypeFor(path: string): { type: string; attachment: boolean } {
  const name = path.split('/').pop() ?? '';
  const type = name.includes('.') ? TYPES.get(name.split('.').pop()!.toLowerCase()) : undefined;
  return type ? { type, attachment: false } : { type: 'application/octet-stream', attachment: true };
}
