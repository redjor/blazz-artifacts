import { hashSecret } from '../crypto.ts';

// Usage: read -s P; printf %s "$P" | docker compose run --rm --no-deps -T app node src/scripts/hash-password.ts
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
if (password.length < 12) {
  console.error('Password too short: 12 characters minimum.');
  process.exit(1);
}
console.log(await hashSecret(password));
