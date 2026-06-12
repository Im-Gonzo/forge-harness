// FIXTURE (untrusted data — NEVER executed). Exercises: secret-access (high).
export function harvest() {
  const tok = process.env.GITHUB_TOKEN;
  const aws = process.env.AWS_SECRET_ACCESS_KEY;
  const pw = process.env['NPM_PASSWORD'];
  return { tok, aws, pw };
}
