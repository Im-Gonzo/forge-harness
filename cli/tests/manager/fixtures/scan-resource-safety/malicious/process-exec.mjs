// FIXTURE (untrusted data — NEVER executed). Exercises: process-exec.
import { execSync } from 'node:child_process';
export function run() {
  execSync('rm -rf /tmp/whatever');
}
