// [agent] Built-in agent runner: answers Direct-tab messages by running the locally installed Claude
// Code CLI headless (`claude -p … --output-format stream-json`) with video-lab's own MCP tools and
// nothing else. Uses the machine's existing Claude login (no API keys handled here); one turn per
// user message; multi-turn context through the CLI's session resume; live steps and reply text are
// streamed to the browser over SSE. Scene edits never apply directly: they arrive as a proposal.
// Never logs prompts, env or tokens to disk.
import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SYSTEM_PROMPT = `You are the director agent built into video-lab: a tool for blocking out a 3D scene (objects with Cast Cards), planning shots with camera moves and keyframe animation, and composing per-shot generation prompts. You talk with a filmmaker inside the app. Be brief, concrete and warm; no preamble, no markdown headings, no bullet lists longer than five items.

The scene: objects (characters, vehicles, props, environment) with position in metres (ground y=0, +z toward the default camera, -x is screen left), yaw rotation in degrees (0 faces the camera), scale, colour, and a Cast Card (description + style notes) that feeds every prompt. Shots have a title, description (mention objects as @handle), duration 0.5–5 s, a start time on the scene timeline, and a camera: a preset move (static, dolly-in/out, truck-left/right, pan-left/right, orbit-left/right, crane-up/down, tilt-up) around a target object with distance, height, angle and lens mm. Objects can be keyframe-animated on the timeline.

How to work:
1. Always call previs_get_scene first; read before you write. Post a short previs_progress line before each meaningful step.
Write replies as short plain sentences: no markdown headings, bold, bullet lists or code formatting (colour values may be written plainly).
2. Scene, shot, camera or animation changes: gather everything the request needs into ONE previs_propose_edit (and/or one previs_propose_animation) call. The app shows a changes card with its real state (small edits may apply at once with Undo; others wait for Apply). Never tell the user to click anything and never claim whether it was applied — just say what the change does in one or two short sentences. Use object and shot names, not invented ids. Keep blockouts simple and editable: a few well-placed shapes beat many. Never put two surfaces on the same plane (they z-fight: flickering stripes in every blockout frame, which image and video models copy): lift a line, decal, rug or sign at least 2 mm off the surface under it along its normal (on a floor whose top is at y, put its bottom at y + 0.002), and do not overlap the faces of two objects flush; when a result has warnings, fix what they name. Keep people at scale 1 and cars realistically sized; put a person ~1.6 m from a car when they are "next to" it.
3. Prompt requests ("write a prompt for shot 3", "make the prompt moodier"): call previs_get_prompt, then write the prompt in your reply AND call previs_suggest_prompt so the user gets a one-click "Use as shot prompt". Stay faithful to the Cast Cards, world and camera; the prompt must describe exactly what the blockout shows. Video prompts describe the action and the look, never the camera move (the blockout is the camera; words like dolly, pan or crane contradict it); image prompts describe a single frame.
4. Questions and advice: answer in chat. Do not propose edits unless asked to change something.
5. You cannot render, generate images or video, or spend money. If asked, explain that the blockout is the Make blockout button and generation is Cast images or Generate, where the user approves a quote.
6. Finish with a short plain reply: what you proposed (one line per change at most) or the answer. If a request is ambiguous in a way that matters (which shot? which object?), ask one short question instead of guessing.`;

const FRIENDLY = {
  previs_get_scene: () => 'Reading the scene',
  previs_get_prompt: a => `Reading shot ${a?.shot ?? ''}’s prompt`.replace('  ', ' '),
  previs_propose_edit: a => `Planning ${Array.isArray(a?.ops) ? a.ops.length : ''} change${Array.isArray(a?.ops) && a.ops.length === 1 ? '' : 's'}`.replace('Planning  ', 'Planning '),
  previs_propose_animation: () => 'Planning the animation',
  previs_suggest_prompt: a => `Writing the ${a?.kind || ''} prompt for shot ${a?.shot ?? ''}`.replace(/\s+/g, ' '),
  Read: a => `Looking at ${String(a?.file_path || '').split('/').pop()}`,
};

async function findClaude() {
  if (process.env.PREVIS_AGENT === 'off') return null;
  const candidates = [process.env.PREVIS_CLAUDE_PATH, join(homedir(), '.local/bin/claude'), ...(process.env.PATH || '').split(':').filter(Boolean).map(d => join(d, 'claude'))].filter(Boolean);
  for (const c of candidates) { try { await access(c, constants.X_OK); return c; } catch {} }
  return null;
}

export async function openAgentRunner({ root, dataDir, port, director }) {
  const binary = await findClaude();
  const model = process.env.PREVIS_AGENT_MODEL || 'sonnet';
  const timeoutMs = Math.max(30, Number(process.env.PREVIS_AGENT_TIMEOUT_S) || 240) * 1000;
  const runs = new Map();       // projectId -> live run
  const sessions = new Map();   // projectId -> claude session id (multi-turn memory)
  const listeners = new Map();  // projectId -> Set<res> (SSE)
  const toolsPath = join(root, 'server/previs/agent-tools.mjs');

  const emit = (projectId, event) => {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of listeners.get(projectId) || []) { try { res.write(data); } catch {} }
  };
  const snapshot = run => run ? { messageId: run.messageId, startedAt: run.startedAt, text: run.text, steps: run.steps.slice(-12) } : null;
  const status = () => ({ available: !!binary, model, busy: [...runs.keys()], runs: Object.fromEntries([...runs].map(([id, r]) => [id, snapshot(r)])) });

  // Child env: the user's login comes from the keychain; drop variables that would make the CLI think
  // it is nested inside another Claude Code session. Nothing is added.
  const childEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE' && !k.startsWith('CLAUDE_CODE_')));

  function args(prompt, { projectId, messageId, resume, attachments }) {
    const mcp = JSON.stringify({ mcpServers: { previs: { command: process.execPath, args: [toolsPath], env: { PREVIS_URL: `http://127.0.0.1:${port}`, PREVIS_PROJECT: projectId, PREVIS_MESSAGE: messageId } } } });
    const tools = attachments.length ? ['Read'] : [''];
    return ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--strict-mcp-config', '--mcp-config', mcp,
      '--tools', ...tools, '--allowedTools', 'mcp__previs__*', ...(attachments.length ? ['Read'] : []), '--permission-mode', 'dontAsk', '--max-turns', '24', '--setting-sources', '',
      '--system-prompt', SYSTEM_PROMPT, '--model', model, ...(resume ? ['--resume', resume] : ['--session-id', randomUUID()])];
  }

  function turnPrompt({ text, shotNumber, shotTitle, attachments, hint }) {
    const head = [`[video-lab] Current shot: ${shotNumber} “${shotTitle}”.`, attachments.length ? `Attached reference images (open with Read): ${attachments.join(', ')}.` : '', hint || ''].filter(Boolean).join(' ');
    return `${head}\n\n${text}`;
  }

  async function finish(run, { text, error }) {
    runs.delete(run.projectId); clearTimeout(run.timer);
    try { await director.reply(run.projectId, { messageId: run.messageId, text: text || (error ? 'The agent could not finish this one.' : 'Done.'), via: 'runner', ...(error ? { error: true } : {}) }); }
    catch (e) { console.error('agent reply failed:', e.message); }
    emit(run.projectId, { type: error ? 'error' : 'done', messageId: run.messageId, text: text || '' });
    // Messages sent while this one ran wait as "queued"; start the oldest now.
    try { const next = await director.nextQueued?.(run.projectId); if (next) api.start(run.projectId, next.messageId, next.input); }
    catch (e) { console.error('agent queue failed:', e.message); }
  }

  function launch(run, prompt, resume) {
    const child = spawn(binary, args(prompt, { ...run, resume }), { cwd: run.cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    run.child = child; run.resumed = !!resume; run.sessionId = null;
    let stderr = '';
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
    const rl = createInterface({ input: child.stdout });
    rl.on('line', line => {
      let ev; try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'system' && ev.subtype === 'init') { run.sessionId = ev.session_id; return; }
      if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta') { run.text += ev.event.delta.text; emit(run.projectId, { type: 'text', messageId: run.messageId, delta: ev.event.delta.text }); return; }
      if (ev.type === 'stream_event' && ev.event?.type === 'content_block_start' && ev.event.content_block?.type === 'text') { run.text = ''; emit(run.projectId, { type: 'text', messageId: run.messageId, reset: true }); return; }
      if (ev.type === 'assistant') {
        for (const block of ev.message?.content || []) {
          if (block.type !== 'tool_use') continue;
          const name = block.name.replace(/^mcp__previs__/, '');
          if (name === 'previs_progress') continue; // the route logs it
          const text = (FRIENDLY[name] || (() => `Using ${name}`))(block.input);
          run.steps.push(text); emit(run.projectId, { type: 'step', messageId: run.messageId, text });
          void director.progress(run.projectId, { messageId: run.messageId, text, auto: true }).catch(() => {});
        }
        return;
      }
      if (ev.type === 'result') run.result = ev;
    });
    child.on('error', e => { run.exitError = e.message; });
    child.on('close', code => {
      rl.close();
      if (run.stopped) return void finish(run, { text: 'Stopped.', error: true });
      const r = run.result;
      if (r && !r.is_error && r.subtype === 'success') { if (run.sessionId) sessions.set(run.projectId, run.sessionId); return void finish(run, { text: String(r.result || run.text || '').trim() }); }
      const message = String(r?.result || r?.errors?.join?.('; ') || run.exitError || stderr.trim().split('\n').pop() || `claude exited with code ${code}`);
      // A stale session is the one failure worth one retry, with a fresh session (nothing paid happens here).
      if (run.resumed && !run.retried && /session|conversation|resume/i.test(message)) { run.retried = true; sessions.delete(run.projectId); run.text = ''; return launch(run, prompt, null); }
      if (/not logged in|login/i.test(message)) return void finish(run, { text: 'Claude Code is not signed in on this Mac. Run `claude` in a terminal once to sign in, then try again.', error: true });
      if (/rate limit|overloaded|529/i.test(message)) return void finish(run, { text: 'Claude is rate-limited right now. Try again in a moment.', error: true });
      void finish(run, { text: `Couldn’t finish: ${message.slice(0, 300)}`, error: true });
    });
  }

  const api = {
    status,
    busy: projectId => runs.has(projectId),
    available: () => !!binary,
    /** Start one turn for a claimed user message. Returns at once; progress streams over SSE and lands in the thread. */
    start(projectId, messageId, input) {
      if (!binary) throw Object.assign(Error('Claude Code is not installed on this Mac'), { status: 503 });
      if (runs.has(projectId)) throw Object.assign(Error('The agent is still working on the previous message'), { status: 409 });
      const run = { projectId, messageId, attachments: Array.isArray(input.attachments) ? input.attachments : [], startedAt: new Date().toISOString(), text: '', steps: [], result: null, child: null, stopped: false, retried: false, cwd: join(dataDir, 'director', projectId) };
      runs.set(projectId, run);
      run.timer = setTimeout(() => { run.stopped = false; run.timedOut = true; run.result = { is_error: true, result: `Timed out after ${Math.round(timeoutMs / 60000)} min` }; run.child?.kill('SIGTERM'); }, timeoutMs);
      emit(projectId, { type: 'start', messageId });
      // From here on the message is claimed, so a failure to start must land in the thread as an error reply (with Retry), never throw.
      try { launch(run, turnPrompt({ ...input, attachments: run.attachments }), sessions.get(projectId) || null); }
      catch (e) { setTimeout(() => void finish(run, { text: `Couldn’t start the agent: ${e.message}`, error: true })); }
      return { started: true, messageId };
    },
    stop(projectId) {
      const run = runs.get(projectId); if (!run) return { stopped: false };
      run.stopped = true; run.child?.kill('SIGTERM'); return { stopped: true, messageId: run.messageId };
    },
    /** Forget the per-project conversation so the next turn starts fresh. */
    reset(projectId) { sessions.delete(projectId); return { reset: true }; },
    /** SSE: live steps and reply text for one project; sends a snapshot first so a refreshed tab catches up. */
    stream(req, res, projectId) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`data: ${JSON.stringify({ type: 'state', available: !!binary, run: snapshot(runs.get(projectId)) })}\n\n`);
      if (!listeners.has(projectId)) listeners.set(projectId, new Set());
      listeners.get(projectId).add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
      req.on('close', () => { clearInterval(ping); listeners.get(projectId)?.delete(res); });
    },
    close() { for (const run of runs.values()) { run.stopped = true; run.child?.kill('SIGTERM'); } },
  };
  return api;
}
