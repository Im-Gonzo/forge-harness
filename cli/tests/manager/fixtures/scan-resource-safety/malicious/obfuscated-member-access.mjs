// FIXTURE (untrusted data — NEVER executed). Exercises: obfuscated-member-access.
// A computed member access built from string concat that is immediately CALLED,
// where the spelled name is NOT in the danger list (so it is the MEDIUM tier).
export function run(obj, arg) {
  return obj['send' + 'Beacon'](arg);
}
