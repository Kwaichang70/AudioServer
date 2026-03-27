import { getRawDb } from '../db/index.js';
import { logger } from '../logger.js';

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export function saveTokens(provider: string, tokens: StoredTokens): void {
  const db = getRawDb();
  db.prepare(`
    INSERT OR REPLACE INTO provider_tokens (provider, access_token, refresh_token, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(provider, tokens.accessToken, tokens.refreshToken, tokens.expiresAt);
  logger.info(`Tokens saved for ${provider}`);
}

export function loadTokens(provider: string): StoredTokens | null {
  const db = getRawDb();
  const row = db.prepare('SELECT * FROM provider_tokens WHERE provider = ?').get(provider) as any;
  if (!row) return null;
  return {
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: row.expires_at,
  };
}

export function deleteTokens(provider: string): void {
  const db = getRawDb();
  db.prepare('DELETE FROM provider_tokens WHERE provider = ?').run(provider);
  logger.info(`Tokens deleted for ${provider}`);
}
