// FIXTURE clean: a pure utility module. No IO, no exec, no network, no secrets.
export function sum(xs) {
  return xs.reduce((a, b) => a + b, 0);
}

export function titleCase(s) {
  return String(s)
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export const NODE_ENV = process.env.NODE_ENV || 'development';
