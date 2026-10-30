import { open, rename } from 'node:fs/promises';

export async function atomicJson(file, value) {
  const temporary = file + '.tmp';
  const handle = await open(temporary, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, file);
}
