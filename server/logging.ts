export function redactLog(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\b(secret|token|password|passwd|authorization)\b\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]');
}
