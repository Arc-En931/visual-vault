// Minimal in-browser test harness. Works on desktop and phone: open tests/index.html over http(s)/localhost.
const tests = [];
export function test(name, fn) { tests.push({ name, fn }); }

export const assert = {
  ok(cond, msg = 'expected truthy') { if (!cond) throw new Error(msg); },
  eq(actual, expected, msg = '') {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e) throw new Error(`${msg} expected ${e} but got ${a}`.trim());
  },
  async rejects(promise, code, msg = '') {
    try { await promise; } catch (e) {
      if (code && e.code !== code) throw new Error(`${msg} expected error code ${code} but got ${e.code || e.name}: ${e.message}`.trim());
      return e;
    }
    throw new Error(`${msg} expected rejection${code ? ' with ' + code : ''} but it resolved`.trim());
  },
};

export async function runAll() {
  const out = document.getElementById('out');
  const results = [];
  for (const t of tests) {
    const start = performance.now();
    try { await t.fn(); results.push({ name: t.name, ok: true, ms: Math.round(performance.now() - start) }); }
    catch (e) { results.push({ name: t.name, ok: false, error: String(e && e.message || e) }); }
  }
  const failed = results.filter((r) => !r.ok);
  if (out) {
    out.innerHTML = `<h2>${results.length - failed.length}/${results.length} passed</h2>` +
      results.map((r) => `<div style="color:${r.ok ? 'green' : 'crimson'}">${r.ok ? 'PASS' : 'FAIL'} — ${r.name}${r.ok ? '' : '<br><small>' + r.error + '</small>'}</div>`).join('');
  }
  window.__vvResults = { done: true, total: results.length, passed: results.length - failed.length, results };
}
