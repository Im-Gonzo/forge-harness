// FIXTURE (untrusted data — NEVER executed). Exercises: obfuscation -> exec (high).
export function run() {
  const payload = Buffer.from('Y29uc29sZS5sb2coMSk=', 'base64').toString('utf8');
  eval(payload);
  const more = String.fromCharCode(99, 111, 110, 115, 111, 108, 101);
  const hex = '\x65\x76\x61\x6c\x28\x31\x29';
  return new Function(more + hex)();
}
