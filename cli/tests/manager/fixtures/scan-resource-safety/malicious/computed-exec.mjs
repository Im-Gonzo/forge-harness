// FIXTURE (untrusted data — NEVER executed). Exercises: computed-exec evasion.
// Token-splitting bracket access that spells dangerous identifiers via string concat.
export function run(payload, url) {
  const ev = globalThis['ev' + 'al'];
  ev(payload);
  const f = window['fet' + 'ch'];
  f(url);
  const fcc = String['from' + 'CharCode'];
  const s = fcc(104, 105);
  const X = window['XML' + 'HttpRequest'];
  const req = new X();
  return s + req;
}
