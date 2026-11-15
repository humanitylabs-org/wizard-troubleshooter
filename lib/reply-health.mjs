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
// A failed mark (limited / expired) holds only until the provider's reset time when the error named one,
// otherwise for at most an hour, so one bad run can never lock an engine out of the picker for days (#50).
export const MARK_TTL = 3600e3;
const MAX_RESET = 7 * 24 * 3600e3;
// The reset time a provider error states, in ms, or null: "…limit reached|1731700000", "try again in 20 minutes", "resets at 2026-11-15T18:00:00Z".
export function resetAt(text, now = Date.now()) {
  const s = String(text || '');
  let t = null, m;
  if ((m = s.match(/\|(\d{10})\b/))) t = Number(m[1]) * 1000;
  else if ((m = s.match(/(?:try again|retry|resets?) in (\d+(?:\.\d+)?)\s*(s|sec|second|m|min|minute|h|hr|hour|d|day)s?\b/i))) t = now + Number(m[1]) * { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[m[2][0].toLowerCase()];
  else if ((m = s.match(/resets? (?:at |on )?(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i))) t = Date.parse(m[1]);
  return Number.isFinite(t) && t > now && t - now <= MAX_RESET ? t : null;
}
export function knownProbe(dir, id, now = Date.now()) {
  const r = read(path.join(dir, `reply-${id}.json`));
  if (!r || r.ok) return r;
  const until = Number(r.resetAt) > 0 ? Number(r.resetAt) : (Number(r.checkedAt) || 0) + MARK_TTL;
  return now < until ? r : null;
}
