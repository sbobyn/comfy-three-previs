import { open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function lockProject(root) {
  const file = join(root, '.server-lock');
  let handle;
  try { handle = await open(file, 'wx', 0o600); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const guard = await open(file + '.recovery', 'wx', 0o600).catch(() => { throw Error('Another process is checking this project lock. Retry startup after that check finishes.'); });
    try {
      const prior = await readFile(file, 'utf8');
      const pid = Number(prior.trim().split(':')[0]);
      if (!Number.isSafeInteger(pid) || pid < 1) throw Error('Project lock is unreadable. Verify its owner before manual recovery.');
      try { process.kill(pid, 0); throw Error(`Project is already owned by process ${pid}. Choose a different PREVIS_DATA_DIR.`); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      await rename(file, file + '.stale-' + randomUUID());
      handle = await open(file, 'wx', 0o600);
    } finally { await guard.close(); await unlink(file + '.recovery'); }
  }
  const token = `${process.pid}:${randomUUID()}`;
  await handle.writeFile(token); await handle.sync();
  return async () => { await handle.close(); if (await readFile(file, 'utf8').catch(() => '') === token) await unlink(file); };
}
