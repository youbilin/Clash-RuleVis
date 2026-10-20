import fsp from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { getActiveProfile, kernel } from './kernel';
import type { BaseTemplateInfo } from '../shared/types';

const BASE_KEYS = [
  'mixed-port',
  'port',
  'socks-port',
  'redir-port',
  'tproxy-port',
  'allow-lan',
  'bind-address',
  'mode',
  'log-level',
  'ipv6',
  'unified-delay',
  'tcp-concurrent',
  'find-process-mode',
  'geodata-mode',
  'geodata-loader',
  'geo-auto-update',
  'interface-name',
  'routing-mark',
  'hosts',
  'dns',
  'profile',
  'sniffer',
  'tun',
];

export interface BaseTemplate {
  values: Record<string, unknown>;
  keys: string[];
  info: BaseTemplateInfo;
}

export async function readBaseTemplate(): Promise<BaseTemplate> {
  const verge = kernel.getVerge();
  const values: Record<string, unknown> = {};

  const applyKeys = (config: Record<string, unknown>) => {
    for (const key of BASE_KEYS) {
      if (values[key] === undefined && config[key] !== undefined) {
        values[key] = config[key];
      }
    }
  };

  const parseFile = async (filePath: string): Promise<Record<string, unknown> | null> => {
    try {
      const raw = await fsp.readFile(filePath, 'utf8');
      const parsed = parseYaml(raw) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };

  let source = 'Clash Verge 运行时配置';
  if (verge?.configPath) {
    const runtime = await parseFile(verge.configPath);
    if (runtime) applyKeys(runtime);
  }

  const profile = await getActiveProfile().catch(() => null);
  if (profile) {
    const profileConfig = await parseFile(profile.filePath);
    if (profileConfig) {
      applyKeys(profileConfig);
      source = verge?.configPath ? 'Clash Verge 运行时配置 + 当前配置' : profile.name;
    }
  }

  if (verge?.dir) {
    const dnsConfig = await parseFile(path.join(verge.dir, 'dns_config.yaml'));
    if (dnsConfig?.dns && typeof dnsConfig.dns === 'object') {
      values.dns = dnsConfig.dns;
    }
  }

  const keys = BASE_KEYS.filter((key) => values[key] !== undefined);
  if (!keys.length) {
    return {
      values: {},
      keys: [],
      info: { included: false, keys: [], warning: '未找到 Clash Verge 当前生效配置' },
    };
  }
  return {
    values,
    keys,
    info: {
      included: true,
      source,
      keys,
    },
  };
}

export function extractBaseSettings(config: Record<string, unknown>): { values: Record<string, unknown>; keys: string[] } {
  const values: Record<string, unknown> = {};
  const keys: string[] = [];
  for (const key of BASE_KEYS) {
    if (config[key] !== undefined) {
      values[key] = config[key];
      keys.push(key);
    }
  }
  return { values, keys };
}
