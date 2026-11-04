// Shared classification and bounded, persistent reply-probe cache. Never persist provider output or credentials.
import fs from 'node:fs';
import path from 'node:path';

// Match provider notices, not an answer that merely discusses authentication or limits.
export function providerFailure(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 1800) return null;
  const notice = /^(?:failed to authenticat|authentication (?:failed|error)|oauth (?:session|refresh token) (?:has )?(?:expired|failed|could not)|oauth error|invalid[_ -]grant|no (?:anthropic|openai|chatgpt|claude|provider|valid api key|usable credential).*credential|(?:error[: ]+)?(?:401|403)\b|(?:api |provider )?error[: ]|(?:your |the )?(?:claude |chatgpt |oauth )?(?:sign.in|session|login|refresh token|access token|credentials?) (?:has |have |is |are )?(?:expired|invalid|missing|revoked|could not|cannot)|(?:your )?authentication token (?:could not|cannot|expired)|please (?:log ?in|sign in)|not logged in|you(?:'|’)?(?:ve| have) (?:hit|reached)|(?:weekly|usage|rate|credit|quota) limit\b(?: reached| exceeded| hit|[.:]|$)|rate.?limit(?:ed| reached| exceeded|[.:]|$)|limit reached|quota exceeded|chatgpt answered (?:401|403|429))/i.test(s);
  if (!notice) return null;
  if (/usage limit|weekly limit|rate.?limit|hit your .*limit|quota|429|limit reached|credit.*limit/i.test(s)) return { state: 'limited', limited: true, signin: false };
  if (/auth|expired|invalid[_ -]grant|401|403|log ?in|sign.in|credential|token.*(?:invalid|revoked|missing|refresh)/i.test(s)) return { state: 'expired', signin: true, limited: false };
  return null;
}
export const providerName = text => /anthropic|claude/i.test(text) ? 'Claude' : /openai|chatgpt|codex/i.test(text) ? 'ChatGPT' : /tinfoil/i.test(text) ? 'Tinfoil' : 'AI provider';
export function replyResult(text, provider = providerName(text)) {
  const f = providerFailure(text);
  if (f) return { ok: false, ...f, provider, detail: `${provider} ${f.signin ? 'sign-in expired' : 'usage limit reached'}.` };
  return /^OK[.!]?$/i.test(String(text || '').trim()) ? { ok: true, detail: 'Replied OK to a real message.' } : { ok: false, state: 'unavailable', detail: 'The reply check did not receive OK.' };
}
const pending = new Map();
const read = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
export async function cachedProbe(dir, id, probe, { force = false, now = Date.now() } = {}) {
  const f = path.join(dir, `reply-${id}.json`), lock = f + '.lock';
  const cached = read(f);
  if (!force && cached && now - cached.checkedAt < (cached.ok ? 600000 : 60000)) return { ...cached, cached: true };
  if (pending.has(f)) return pending.get(f);
  const job = (async () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let acquired = false;
    for (let i = 0; i < 700; i++) {
      try { fs.mkdirSync(lock); acquired = true; break; } catch {
      // A second process shares the in-flight probe, rather than spending another request.
        await new Promise(r => setTimeout(r, 100));
        const r = read(f);
        if (r && r.checkedAt > (cached?.checkedAt || 0)) return { ...r, cached: true };
        try { if (Date.now() - fs.statSync(lock).mtimeMs > 90000) fs.rmdirSync(lock); } catch {}
      }
    }
    if (!acquired) return { ok: false, state: 'unavailable', detail: 'The reply check is still waiting.', checkedAt: now, cached: true };
    try {
      let r;
      try { r = await probe(); } catch { r = { ok: false, state: 'unavailable', detail: 'The reply check could not connect.' }; }
      const result = { ...r, checkedAt: Date.now() };
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(result), { mode: 0o600 }); fs.renameSync(tmp, f);
      return result;
    } finally { try { fs.rmdirSync(lock); } catch {} }
  })();
  pending.set(f, job);
  try { return await job; } finally { pending.delete(f); }
}
export function rememberProbe(dir, id, result) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = path.join(dir, `reply-${id}.json`), tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...result, checkedAt: Date.now() }), { mode: 0o600 }); fs.renameSync(tmp, f);
}
export function knownProbe(dir, id) { return read(path.join(dir, `reply-${id}.json`)); }
