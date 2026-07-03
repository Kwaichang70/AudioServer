import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'crypto';
import { getRawDb } from '../db/index.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const ALGORITHM = 'aes-256-gcm';
const SALT = 'audioserver-token-encryption';

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

function deriveKey(): Buffer {
  return pbkdf2Sync(config.jwtSecret, SALT, 100000, 32, 'sha256');
}

function encrypt(text: string): string {
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Format: iv:authTag:encrypted (all base64)
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decrypt(data: string): string {
  const parts = data.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted data format');

  const key = deriveKey();
  const iv = Buffer.from(parts[0], 'base64');
  const authTag = Buffer.from(parts[1], 'base64');
  const encrypted = Buffer.from(parts[2], 'base64');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

export function saveTokens(provider: string, tokens: StoredTokens): void {
  const db = getRawDb();
  const encAccess = encrypt(tokens.accessToken);
  const encRefresh = encrypt(tokens.refreshToken);
  db.prepare(
    `
    INSERT OR REPLACE INTO provider_tokens (provider, access_token, refresh_token, expires_at)
    VALUES (?, ?, ?, ?)
  `,
  ).run(provider, encAccess, encRefresh, tokens.expiresAt);
  logger.info(`Tokens saved for ${provider} (encrypted)`);
}

// Our encrypted format is exactly three base64 chunks joined by ':'. Real
// OAuth tokens never look like that, so this cleanly separates "legacy
// plaintext row" from "encrypted row we failed to decrypt".
function looksEncrypted(value: unknown): boolean {
  return typeof value === 'string' && value.split(':').length === 3;
}

export function loadTokens(provider: string): StoredTokens | null {
  const db = getRawDb();
  const row = db.prepare('SELECT * FROM provider_tokens WHERE provider = ?').get(provider) as any;
  if (!row) return null;

  try {
    return {
      accessToken: decrypt(row.access_token),
      refreshToken: decrypt(row.refresh_token),
      expiresAt: row.expires_at,
    };
  } catch {
    // Only rows that DON'T look encrypted are legacy plaintext tokens. A row
    // that looks encrypted but fails to decrypt (JWT_SECRET changed, corrupt
    // data) must NOT be treated as plaintext — doing so would hand ciphertext
    // to the provider as if it were a token AND re-encrypt it, permanently
    // destroying the original. Leave the row intact (a restored JWT_SECRET
    // can still decrypt it) and report as not authenticated.
    if (looksEncrypted(row.access_token) || looksEncrypted(row.refresh_token)) {
      logger.error(
        `Cannot decrypt stored ${provider} tokens (JWT_SECRET changed or data corrupt) — re-connect the provider in Settings`,
      );
      return null;
    }
    // Plaintext migration: old tokens stored unencrypted, re-encrypt them
    logger.info(`Migrating plaintext tokens for ${provider} to encrypted storage`);
    const tokens: StoredTokens = {
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiresAt: row.expires_at,
    };
    saveTokens(provider, tokens);
    return tokens;
  }
}

export function deleteTokens(provider: string): void {
  const db = getRawDb();
  db.prepare('DELETE FROM provider_tokens WHERE provider = ?').run(provider);
  logger.info(`Tokens deleted for ${provider}`);
}
