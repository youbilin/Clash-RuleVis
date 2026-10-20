import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import type { EdgeRuleType, InlineRule, RuleSetInspect, RulesetBehavior, RulesetFormat } from '../shared/types';
import { isIPv4, isIPv6 } from '../shared/model';
import { RULE_SETS_DIR } from './paths';
import { isPathInside } from './fsutil';
import { parseRuleLine } from './importer';

const INLINE_RULE_TYPES = new Set<string>([
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'IP-CIDR',
  'IP-CIDR6',
  'PROCESS-NAME',
  'PROCESS-PATH',
  'GEOSITE',
  'GEOIP',
  'DST-PORT',
]);

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  return sample.includes(0);
}

function formatFromHint(hint: string): RulesetFormat | null {
  if (/\.mrs(?:$|\?)/i.test(hint)) return 'mrs';
  if (/\.ya?ml(?:$|\?)/i.test(hint)) return 'yaml';
  if (/\.(txt|list)(?:$|\?)/i.test(hint)) return 'text';
  return null;
}

function behaviorFromHint(hint: string): RulesetBehavior | null {
  if (/geoip|ipcidr|ip-list|\/ip\b|cn-ip|ip\./i.test(hint)) return 'ipcidr';
  if (/geosite|domain/i.test(hint)) return 'domain';
  return null;
}

function payloadLines(text: string, format: RulesetFormat): string[] {
  if (format === 'yaml') {
    try {
      const parsed = parseYaml(text) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === 'string');
      }
      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { payload?: unknown }).payload)) {
        return (parsed as { payload: unknown[] }).payload.filter(
          (v): v is string => typeof v === 'string',
        );
      }
    } catch {
      // YAML 解析失败时退回逐行解析
    }
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('//'))
    .filter((line) => !/^(payload|rules)\s*:/.test(line));
}

function isClassicalRule(line: string): boolean {
  const parts = line.split(',');
  if (parts.length < 2) return false;
  const type = parts[0].trim().toUpperCase();
  return INLINE_RULE_TYPES.has(type) || type === 'RULE-SET' || type === 'MATCH';
}

function countRules(text: string, format: RulesetFormat): number {
  const lines = payloadLines(text, format);
  if (lines.some(isClassicalRule)) {
    return lines.filter((line) => isClassicalRule(line)).length;
  }
  return lines.length;
}

function guessBehavior(text: string, hint: string, format: RulesetFormat): RulesetBehavior {
  const hinted = behaviorFromHint(hint);
  const lines = payloadLines(text, format).slice(0, 200);
  if (lines.some(isClassicalRule)) return 'classical';
  const ipCount = lines.filter((line) => {
    const [maybeIp] = line.split('/');
    return isIPv4(line) || isIPv6(line) || isIPv4(maybeIp ?? '') || isIPv6(maybeIp ?? '');
  }).length;
  if (lines.length > 0 && ipCount / lines.length > 0.5) return 'ipcidr';
  if (hinted) return hinted;
  return 'domain';
}

export function inspectRuleSetBuffer(
  buffer: Buffer,
  options: { fileName?: string; url?: string },
): RuleSetInspect {
  const hint = options.url ?? options.fileName ?? '';
  const binary = looksBinary(buffer);
  const hintedFormat = formatFromHint(hint);
  let format: RulesetFormat = binary ? 'mrs' : (hintedFormat ?? 'text');
  const text = binary ? '' : buffer.toString('utf8').replace(/^\uFEFF/, '');

  if (!binary && (hintedFormat === null || hintedFormat === 'text')) {
    if (/^\s*(payload|rules)\s*:/m.test(text)) format = 'yaml';
  }
  if (format === 'mrs' && !binary && hintedFormat !== 'mrs') format = 'text';

  if (format === 'mrs') {
    return {
      format,
      behavior: behaviorFromHint(hint) ?? 'domain',
      sample: [],
      size: buffer.length,
      textAvailable: false,
      fileName: options.fileName,
      sourceType: options.url ? 'url' : 'file',
      sourceValue: options.url ?? '',
    };
  }

  const behavior = guessBehavior(text, hint, format);
  const lines = payloadLines(text, format);
  return {
    format,
    behavior,
    ruleCount: countRules(text, format),
    sample: lines.slice(0, 6),
    size: buffer.length,
    textAvailable: true,
    fileName: options.fileName,
    sourceType: options.url ? 'url' : 'file',
    sourceValue: options.url ?? '',
  };
}

export function expandRuleset(
  buffer: Buffer,
  behavior: RulesetBehavior,
  format: RulesetFormat,
): InlineRule[] {
  if (format === 'mrs') throw new Error('MRS 是二进制格式，无法内联展开');
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const lines = payloadLines(text, format);
  const result: InlineRule[] = [];
  for (const line of lines) {
    if (behavior === 'classical') {
      const rule = parseRuleLine(line);
      if (!rule || !INLINE_RULE_TYPES.has(rule.type)) continue;
      result.push({
        type: rule.type as EdgeRuleType,
        payload: rule.payload,
        noResolve: rule.noResolve || undefined,
      });
      continue;
    }
    if (behavior === 'domain') {
      let payload = line.trim();
      if (!payload || payload.startsWith('#') || payload.startsWith('//')) continue;
      let type: EdgeRuleType = 'DOMAIN';
      if (/^(\+\.|\*\.|\.)/.test(payload)) {
        payload = payload.replace(/^(\+\.|\*\.|\.)/, '');
        type = 'DOMAIN-SUFFIX';
      }
      if (!payload || payload.includes(' ') || payload.includes('/')) continue;
      result.push({ type, payload });
      continue;
    }
    const payload = line.trim();
    if (!payload) continue;
    const ipPart = payload.split('/')[0] ?? '';
    if (isIPv6(ipPart)) {
      result.push({ type: 'IP-CIDR6', payload, noResolve: true });
    } else if (isIPv4(ipPart)) {
      result.push({ type: 'IP-CIDR', payload, noResolve: true });
    }
  }
  return result;
}

export function sanitizeFileName(name: string): string {
  const base = path.basename(name).replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_');
  return base.slice(0, 80) || 'ruleset.txt';
}

export async function storeRuleSetFile(buffer: Buffer, fileName: string): Promise<string> {
  const safe = sanitizeFileName(fileName);
  const stored = path.join(RULE_SETS_DIR, `${randomUUID()}-${safe}`);
  if (!isPathInside(RULE_SETS_DIR, stored)) throw new Error('非法的规则集文件名');
  await fsp.mkdir(RULE_SETS_DIR, { recursive: true });
  await fsp.writeFile(stored, buffer);
  return stored;
}
