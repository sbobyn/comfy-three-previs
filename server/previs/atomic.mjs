import { open, rename } from 'node:fs/promises';

// indent 0 writes compact JSON (large stores); 2 keeps small receipts readable.
export async function atomicJson(file, value, indent = 2) {
  const temporary = file + '.tmp';
  const handle = await open(temporary, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, indent)); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, file);
}
