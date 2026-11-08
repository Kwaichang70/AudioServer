/**
 * When the server last told a speaker to seek (ANALYSE_EN_VERBETERPLAN B02).
 * A renderer that falls back to 0:05 just after we asked it to was seeked,
 * not moved to the next track — the device monitor cannot tell the two apart
 * from the position alone.
 */
const seeks = new Map<string, number>();

export function noteSeek(deviceId: string, now = Date.now()): void {
  seeks.set(deviceId, now);
}

export function seekedWithin(deviceId: string, ms: number, now = Date.now()): boolean {
  const at = seeks.get(deviceId);
  return at !== undefined && now - at < ms;
}
