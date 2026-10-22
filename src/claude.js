// Bridge to the Claude Code CLI in headless mode (`claude -p`), so the "brain" runs on the
// user's Claude subscription. Auth: CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`.
import { spawn } from 'node:child_process';
import { bins, env, ROOT } from './config.js';

export class ClaudeError extends Error {}

/**
 * Ask Claude for structured JSON.
 * @param {string} prompt
 * @param {object} opts { schema, model, tools: string[], cwd, maxTurns, timeoutMs, system, log }
 */
export async function askClaude(prompt, opts = {}) {
  const { schema, model = env('CLAUDE_MODEL', 'opus'), tools = [], cwd = ROOT, maxTurns = 12,
    timeoutMs = 15 * 60_000, system, log, retries = 1, addDirs = [] } = opts;
  if (!bins.claude) throw new ClaudeError('Claude Code CLI not found. Set CLAUDE_BIN in .env.');

  const args = ['-p', '--output-format', 'json', '--model', model, '--max-turns', String(maxTurns)];
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  // each allowed tool (pattern) is its own argument: patterns like "Bash(node x.js:*)" contain spaces
  if (tools.length) args.push('--allowedTools', ...tools);
  else args.push('--tools', '');
  if (addDirs.length) args.push('--add-dir', ...addDirs);
  if (system) args.push('--append-system-prompt', system);

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const raw = await run(bins.claude, args, prompt, cwd, timeoutMs);
      let res;
      try { res = JSON.parse(raw); } catch { throw new ClaudeError(`Unparseable CLI output: ${raw.slice(0, 400)}`); }
      if (res.is_error) throw new ClaudeError(`Claude error: ${res.result || res.terminal_reason || 'unknown'}`);
      if (!schema) return res.result;
      if (res.structured_output) return res.structured_output;
      return extractJson(res.result);
    } catch (e) {
      lastErr = e;
      log?.warn(`Claude call failed (attempt ${attempt + 1}): ${e.message}`);
      if (/401|authenticate|OAuth/i.test(e.message)) break;   // retrying won't fix auth
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
