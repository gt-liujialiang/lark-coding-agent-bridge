export function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}

export function escapeCode(s: string): string {
  return s.replace(/`/g, "'");
}
