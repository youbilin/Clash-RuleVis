export function formatBytes(value: number | undefined, digits = 1): string {
  if (!value || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index === 0 ? 0 : digits)} ${units[index]}`;
}

export function formatRate(value: number | undefined): string {
  if (!value || value <= 0) return '0 B/s';
  return `${formatBytes(value)}/s`;
}

export function formatCompact(value: number | undefined): string {
  if (!value) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${(value / 1000).toFixed(1)}k`;
  return value.toLocaleString('zh-CN');
}

export function formatDelay(delay: number | undefined | null): string {
  return delay && delay > 0 ? `${delay} ms` : '—';
}

export function delayTone(delay: number | undefined | null): 'good' | 'mid' | 'bad' | 'none' {
  if (!delay || delay <= 0) return 'none';
  if (delay < 120) return 'good';
  if (delay < 300) return 'mid';
  return 'bad';
}

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatDateTime(value: string | number | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return dateTimeFormatter.format(date);
}

export function formatRelative(timestamp: number | undefined, now = Date.now()): string {
  if (!timestamp) return '—';
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 2) return '刚刚';
  if (seconds < 60) return `${seconds}s 前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m 前`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h 前`;
}

export function formatTrafficAmount(value: number | undefined): string {
  if (!value) return '—';
  const gb = value / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = value / 1024 ** 2;
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

export function expiresIn(expire: number | undefined): string {
  if (!expire) return '长期';
  const days = Math.ceil((expire * 1000 - Date.now()) / 86_400_000);
  if (days <= 0) return '已到期';
  if (days < 60) return `${days} 天后到期`;
  return `${Math.floor(days / 30)} 个月后到期`;
}
