// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// A minimal MCP stdio client for the authoring scripts: it starts server/previs/agent.mjs against a running Previs
// server (PREVIS_URL) and calls its tools exactly as Claude or another agent would. Tool errors throw.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const AGENT = fileURLToPath(new URL('../../server/previs/agent.mjs', import.meta.url));

export async function connect(url) {
  const child = spawn(process.execPath, [AGENT], { env: { ...process.env, PREVIS_URL: url }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map(); let seq = 0;
  createInterface({ input: child.stdout }).on('line', line => {
    let m; try { m = JSON.parse(line); } catch { return; }
    const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
    if (m.error) p.reject(Error(m.error.message)); else p.resolve(m.result);
  });
  const rpc = (method, params) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'starter-author', version: '1' } });
  /** Call a tool; returns its JSON result (or the raw content for image tools). */
  const call = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    const text = r.content?.find(c => c.type === 'text')?.text;
    if (r.isError) throw Error(`${name}: ${text}`);
    if (r.content?.some(c => c.type === 'image')) return r.content;
    try { return JSON.parse(text); } catch { return text; }
  };
  return { call, close: () => child.kill() };
}
