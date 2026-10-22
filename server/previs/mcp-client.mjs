import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// MCP stdio client. The configured process is the real upstream Blender MCP server.
export class BlenderMcp {
  pending = new Map();
  sequence = 0;
  async connect() {
    if (this.ready) return this.ready;
    this.ready = this.start().catch(error => { this.close(); throw error; });
    return this.ready;
  }
  async start() {
    const command = process.env.PREVIS_BLENDER_MCP_COMMAND;
    if (!command) throw Error('Configure PREVIS_BLENDER_MCP_COMMAND and PREVIS_BLENDER_MCP_ARGS, then start the Blender MCP addon.');
    const args = JSON.parse(process.env.PREVIS_BLENDER_MCP_ARGS || '[]');
    if (!Array.isArray(args) || args.some(x => typeof x !== 'string')) throw Error('MCP arguments must be a JSON string array');
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, BLENDER_MCP_DISABLE_TELEMETRY: '1' } });
    // Never forward upstream stderr: it may include local configuration.
    this.child.stderr.resume();
    const fail = () => { for (const entry of this.pending.values()) entry.reject(Error('Blender MCP process stopped')); this.pending.clear(); this.ready = null; };
    this.child.on('error', fail); this.child.on('exit', fail);
    createInterface({ input: this.child.stdout }).on('line', line => {
      try { const msg = JSON.parse(line); const entry = this.pending.get(msg.id); if (!entry) return;
        this.pending.delete(msg.id); msg.error ? entry.reject(Error(msg.error.message)) : entry.resolve(msg.result);
      } catch { /* Non-protocol output is not returned to the browser. */ }
    });
    const info = await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'comfy-previs', version: '0.1.0' } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await this.request('tools/list', {});
    if (!list.tools?.some(t => t.name === 'execute_blender_code')) throw Error('Blender MCP must expose execute_blender_code');
    return info.serverInfo;
  }
  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); this.uncertain = true; reject(Error('Blender MCP timed out. Verify Blender has finished, then restart Previs.')); }, 190000);
      this.pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async execute(code) {
    if (this.uncertain) throw Error('A Blender operation timed out; verify Blender has finished and restart Previs before continuing.');
    await this.connect();
    let result;
    try { result = await this.request('tools/call', { name: 'execute_blender_code', arguments: { code } }); }
    catch (e) { this.uncertain = true; throw e; }
    const output = (result.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    if (result.isError) { this.uncertain = true; throw Error('Blender MCP operation failed: ' + output.slice(0, 500)); }
    const marker = output.lastIndexOf('PREVIS_JSON:');
    if (marker < 0) { this.uncertain = true; throw Error('Blender operation did not complete reliably. Verify Blender has finished, then restart Previs before retrying.'); }
    // Some upstream versions encode execution output inside a JSON text block.
    for (const candidate of [output, ...result.content.flatMap(c => { try { const v = JSON.parse(c.text); return [v.result, v.output, v.result?.result].filter(x => typeof x === 'string'); } catch { return []; } })]) {
      const i = candidate.lastIndexOf('PREVIS_JSON:');
      if (i >= 0) { try { return JSON.parse(candidate.slice(i + 12).trim()); } catch {} }
    }
    this.uncertain = true; throw Error('Could not decode the Blender result. Verify Blender has finished, then restart Previs.');
  }
  close() { this.child?.kill(); this.ready = null; }
}
