// Bridge to the Claude Code CLI in headless mode (`claude -p`), so the "brain" runs on the
// user's Claude subscription. Auth: CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`.
import { spawn } from 'node:child_process';
import { bins, env, ROOT } from './config.js';

export class ClaudeError extends Error {}
// The subscription's usage limit was reached: the work must pause until resetAt (ms), not fail or fall back.
export class ClaudeLimitError extends ClaudeError { constructor(msg, resetAt) { super(msg); this.limit = true; this.resetAt = resetAt; } }
const isLimit = msg => /hit your (session |usage |weekly |daily )?limit|usage limit reached|rate_limit|limit · resets/i.test(msg);
/** "…resets 6:40pm (Asia/Colombo)" or "…resets Oct 23, 3pm" → epoch ms (the PC's local time); 1 h from now if unparseable. */
export function parseReset(msg, now = new Date()) {
  const m = String(msg).match(/resets\s+(?:([A-Z][a-z]{2}\s+\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!m) return now.getTime() + 60 * 60_000;
  const d = new Date(now);
  if (m[1]) { const x = new Date(`${m[1]} ${d.getFullYear()}`); if (!isNaN(x)) d.setMonth(x.getMonth(), x.getDate()); }
  d.setHours((+m[2] % 12) + (/pm/i.test(m[4]) ? 12 : 0), +(m[3] || 0), 0, 0);
  if (!m[1] && d.getTime() < now.getTime() - 60_000) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// Token accounting for the current run (one pipeline per process): the dashboard and logs show what each video cost.
export const usage = {
  calls: [], reset() { this.calls = []; },
  total() { return this.calls.reduce((a, c) => ({ usd: a.usd + c.usd, tokens: a.tokens + c.tokens, out: a.out + c.out }), { usd: 0, tokens: 0, out: 0 }); },
};

/**
 * Ask Claude for structured JSON.
 * @param {string} prompt
 * @param {object} opts { schema, model, tools: string[], cwd, maxTurns, timeoutMs, system, log }
 */
export async function askClaude(prompt, opts = {}) {
  const { schema, model = env('CLAUDE_MODEL', 'opus'), tools = [], cwd = ROOT, maxTurns = 12,
    timeoutMs = 15 * 60_000, system, log, retries = 1, addDirs = [], label = 'claude' } = opts;
  if (!bins.claude) throw new ClaudeError('Claude Code CLI not found. Set CLAUDE_BIN in .env.');

  const args = ['-p', '--output-format', 'json', '--model', model, '--max-turns', String(maxTurns)];
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  // Lean sessions: only the tools this step needs, and none of the PC's MCP servers, plugins or skills
  // (they added ~25k tokens of tool/skill descriptions to EVERY turn). Each allowed pattern is its own argument:
  // patterns like "Bash(node x.js:*)" contain spaces.
  const names = [...new Set(tools.map(t => t.replace(/\(.*$/, '')))];
  args.push('--tools', names.join(','), '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--setting-sources', 'project');
  if (tools.length) args.push('--allowedTools', ...tools);
  if (addDirs.length) args.push('--add-dir', ...addDirs);
  if (system) args.push('--append-system-prompt', system);

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const raw = await run(bins.claude, args, prompt, cwd, timeoutMs);
      let res;
      try { res = JSON.parse(raw); } catch { throw new ClaudeError(`Unparseable CLI output: ${raw.slice(0, 400)}`); }
      const u = res.usage || {}, tokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      usage.calls.push({ label, model, usd: res.total_cost_usd || 0, tokens, out: u.output_tokens || 0, turns: res.num_turns || 0 });
      log?.info(`${label}: ${res.num_turns ?? '?'} turns, ${(tokens / 1e6).toFixed(2)}M context + ${((u.output_tokens || 0) / 1e3).toFixed(0)}k output tokens (≈$${(res.total_cost_usd || 0).toFixed(2)} at API prices)`);
      if (res.is_error) {
        const msg = `Claude error: ${res.result || res.terminal_reason || 'unknown'}`;
        throw isLimit(msg) ? new ClaudeLimitError(msg, parseReset(msg)) : new ClaudeError(msg);
      }
      if (!schema) return res.result;
      if (res.structured_output) return res.structured_output;
      return extractJson(res.result);
    } catch (e) {
      lastErr = e;
      log?.warn(`Claude call failed (attempt ${attempt + 1}): ${e.message}`);
      if (e.limit || /401|authenticate|OAuth/i.test(e.message)) break;   // retrying won't fix auth or a usage limit
    }
  }
  throw lastErr;
}

function extractJson(text = '') {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try { return JSON.parse(body); } catch { throw new ClaudeError(`Expected JSON, got: ${text.slice(0, 300)}`); }
}

function run(cmd, args, stdin, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env: process.env, windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill(); reject(new ClaudeError(`Claude timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => {
      clearTimeout(timer);
      if (out.trim()) return resolve(out);
      reject(new ClaudeError(`claude exited ${code}: ${err.slice(0, 500)}`));
    });
    p.stdin.end(stdin);
  });
}
