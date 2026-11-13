import { randomToken, sha256 } from '../crypto.ts';

// Usage: docker run --rm --network none blazz-artifacts node src/scripts/new-api-token.ts
// Prints the token (for the publish CLI) and its hash (for API_TOKEN_HASH).
const token = randomToken(32);
console.log(`token=${token}`);
console.log(`hash=${sha256(token)}`);
