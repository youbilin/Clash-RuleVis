export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

export function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function baseName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

export function repositoryUrl(source: string): string | null {
  try {
    const url = new URL(source);
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split('/').filter(Boolean);
    if (host === 'raw.githubusercontent.com' && parts.length >= 2) {
      return `https://github.com/${parts[0]}/${parts[1]}`;
    }
    if (host === 'github.com' && parts.length >= 2) {
      return `https://github.com/${parts[0]}/${parts[1].replace(/\.git$/, '')}`;
    }
    if (host === 'cdn.jsdelivr.net' && parts[0] === 'gh' && parts.length >= 3) {
      return `https://github.com/${parts[1]}/${parts[2].split('@')[0]}`;
    }
    if (host === 'gitee.com' && parts.length >= 2) {
      return `https://gitee.com/${parts[0]}/${parts[1].replace(/\.git$/, '')}`;
    }
  } catch {
    return null;
  }
  return null;
}

export function urlTail(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const last = pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : new URL(url).host;
  } catch {
    return url;
  }
}
