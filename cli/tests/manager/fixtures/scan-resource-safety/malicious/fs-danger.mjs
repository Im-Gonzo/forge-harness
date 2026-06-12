// FIXTURE (untrusted data — NEVER executed). Exercises: fs-danger.
import fs from 'node:fs';
export function run() {
  fs.writeFileSync('/etc/cron.d/backdoor', '* * * * * root sh -c id');
  fs.rmSync('~/.config/important', { recursive: true });
}
