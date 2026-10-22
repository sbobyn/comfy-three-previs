import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// MCP stdio client for the actual upstream server. Never expose arbitrary code
// through HTTP; only app-owned scripts call execute().
export class BlenderMcp {
  sequence = 0;
  uncertain = false;
  constructor({ timeout = 190000, handshakeTimeout = 15000 } = {}) {
    this.timeout = timeout; this.handshakeTimeout = handshakeTimeout;
  }
  async connect() {
    if (this.ready) return this.ready;
    this.ready = this.start().catch(error => { this.close(); throw error; });
    return this.ready;
  }
  async start() {
    const command = process.env.PREVIS_BLENDER_MCP_COMMAND;
    if (!command) throw Error('Blender MCP command is missing. Set PREVIS_BLENDER_MCP_COMMAND and PREVIS_BLENDER_MCP_ARGS, then start the addon in Blender.');
    const args = JSON.parse(process.env.PREVIS_BLENDER_MCP_ARGS || '[]');
    if (!Array.isArray(args) || args.some(x => typeof x !== 'string')) throw Error('MCP arguments must be a JSON string array');
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, BLENDER_MCP_DISABLE_TELEMETRY: '1' } });
    const session = { child, pending: new Map() }; this.session = session;
    child.stderr.resume(); // Upstream logs may contain configuration; never forward them.
    const fail = () => {
      for (const entry of session.pending.values()) entry.reject(Error('Blender MCP process stopped. Verify the configured executable and addon connection.'));
      session.pending.clear();
      if (this.session === session) { this.ready = null; this.serverInfo = null; }
    };
    child.on('error', fail); child.on('exit', fail); child.stdin.on('error', fail);
    createInterface({ input: child.stdout }).on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      const entry = session.pending.get(message.id); if (!entry) return;
      session.pending.delete(message.id);
      message.error ? entry.reject(Error(message.error.message)) : entry.resolve(message.result);
    });
    const info = await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'comfy-previs', version: '0.1.0' } }, this.handshakeTimeout);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await this.request('tools/list', {}, this.handshakeTimeout);
    if (!list.tools?.some(t => t.name === 'execute_blender_code')) throw Error('Blender MCP must expose execute_blender_code');
    this.serverInfo = info.serverInfo;
    return this.serverInfo;
  }
  request(method, params, timeout = this.timeout) {
    const session = this.session;
    if (!session || session.child.exitCode !== null) return Promise.reject(Error('Blender MCP is not connected'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const settle = (fn, value) => { clearTimeout(timer); session.pending.delete(id); fn(value); };
      const timer = setTimeout(() => settle(reject, Error('Blender MCP response timed out. No cancellation was sent.')), timeout);
      session.pending.set(id, { resolve: v => settle(resolve, v), reject: e => settle(reject, e) });
      session.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', error => { if (error) settle(reject, Error('Blender MCP transport closed')); });
    });
  }
  async execute(code, { mutation = true } = {}) {
    if (this.uncertain) throw Error('An earlier Blender operation is unresolved. Use the reconciliation panel; restarting does not cancel it.');
    await this.connect();
    try {
      const result = await this.request('tools/call', { name: 'execute_blender_code', arguments: { code } });
      const contents = (result?.content || []).filter(c => c.type === 'text').map(c => c.text);
      if (result?.isError) throw Error('Blender MCP reported an execution error');
      const candidates = contents.flatMap(text => {
        try { const v = JSON.parse(text); return [text, v.result, v.output, v.result?.result].filter(x => typeof x === 'string'); }
        catch { return [text]; }
      });
      for (const candidate of candidates) {
        const i = candidate.lastIndexOf('PREVIS_JSON:');
        if (i >= 0) { try { return JSON.parse(candidate.slice(i + 12).trim()); } catch {} }
      }
      throw Error('Blender did not return a complete result. Check that the MCP addon is running on the configured host and port.');
    } catch (e) { if (mutation) this.uncertain = true; throw e; }
  }
  reconcile() { this.close(); this.uncertain = false; }
  close() {
    const session = this.session; this.session = null; this.ready = null; this.serverInfo = null;
    if (session) { for (const entry of session.pending.values()) entry.reject(Error('Previs disconnected; Blender may still be working.')); session.pending.clear(); session.child.kill(); }
  }
}
