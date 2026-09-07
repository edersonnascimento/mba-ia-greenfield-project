import * as crypto from 'crypto';

const ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = 62n;

export function generateUniqueId(): string {
  const bytes = crypto.randomBytes(8);
  let value = 0n;
  for (const b of bytes) {
    value = (value << 8n) | BigInt(b);
  }
  let out = '';
  while (value > 0n) {
    out = ALPHABET[Number(value % BASE)] + out;
    value = value / BASE;
  }
  return out.length === 0 ? ALPHABET[0] : out;
}
