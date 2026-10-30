import { createHash } from 'node:crypto';
import { open, rename } from 'node:fs/promises';

// Count attempts before side effects, including interrupted attempts. Restart never resets the budget.
export const RECOVERY_ATTEMPTS = 3;
export const recoveryAttempts = (job, phase) => job.recovery?.[phase] || 0;
export const beginRecovery = (job, phase) => ({ ...job, recovery: { ...job.recovery, [phase]: recoveryAttempts(job, phase) + 1 } });
export const recoveryId = (requestId, key) => {
  const h = createHash('sha256').update(`${requestId}:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
// Stable destination + atomic replacement makes a crash before the receipt write safe to replay.
export async function saveResultBytes(file, bytes) {
  const handle = await open(file + '.tmp', 'w', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(file + '.tmp', file);
}
