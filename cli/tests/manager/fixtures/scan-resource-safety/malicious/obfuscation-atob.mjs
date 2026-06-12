// FIXTURE (untrusted data — NEVER executed). Exercises: obfuscation via atob/decodeURIComponent.
export function run() {
  const a = atob('Y29uc29sZS5sb2coMSk=');
  eval(a);
  const b = decodeURIComponent('%63%6f%6e%73%6f%6c%65');
  return new Function(b)();
}
