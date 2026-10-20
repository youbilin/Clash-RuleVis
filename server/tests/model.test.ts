import test from 'node:test';
import assert from 'node:assert/strict';
import type { Route, RuleRoute } from '../../shared/types';
import {
  coversRule,
  detectRegionSafe,
  findCoveringRoute,
  insertRouteOrdered,
  suggestRootDomain,
} from './helpers';

test('suggestRootDomain uses the public suffix list', () => {
  assert.equal(suggestRootDomain('www.bilibili.com'), 'bilibili.com');
  assert.equal(suggestRootDomain('a.b.example.co.uk'), 'example.co.uk');
  assert.equal(suggestRootDomain('127.0.0.1'), '127.0.0.1');
  assert.equal(suggestRootDomain('localhost'), 'localhost');
});

test('domain rules cover more specific rules', () => {
  const suffix = rule({ type: 'DOMAIN-SUFFIX', payload: 'example.com' });
  assert.equal(coversRule(suffix, rule({ type: 'DOMAIN', payload: 'www.example.com' })), true);
  assert.equal(coversRule(suffix, rule({ type: 'DOMAIN-SUFFIX', payload: 'sub.example.com' })), true);
  assert.equal(coversRule(suffix, rule({ type: 'DOMAIN-SUFFIX', payload: 'example.org' })), false);
  assert.equal(coversRule(rule({ type: 'DOMAIN-KEYWORD', payload: 'google' }), rule({ type: 'DOMAIN-SUFFIX', payload: 'googleapis.com' })), true);
  assert.equal(coversRule(rule({ type: 'MATCH', payload: '' }), rule({ type: 'DOMAIN', payload: 'anything.com' })), true);
});

test('IP CIDR containment is handled for IPv4', () => {
  const outer = rule({ type: 'IP-CIDR', payload: '10.0.0.0/8' });
  assert.equal(coversRule(outer, rule({ type: 'IP-CIDR', payload: '10.1.0.0/16' })), true);
  assert.equal(coversRule(outer, rule({ type: 'IP-CIDR', payload: '11.0.0.0/16' })), false);
  assert.equal(coversRule(rule({ type: 'IP-CIDR', payload: '10.1.0.0/16' }), rule({ type: 'IP-CIDR', payload: '10.0.0.0/8' })), false);
});

test('findCoveringRoute returns the first matching rule', () => {
  const routes: Route[] = [
    rule({ id: 'a', type: 'DOMAIN-SUFFIX', payload: 'example.com' }),
    rule({ id: 'b', type: 'DOMAIN', payload: 'www.example.com' }),
  ];
  const cover = findCoveringRoute(routes, 1);
  assert.equal(cover?.index, 0);
  assert.equal(cover?.route.id, 'a');
});

test('insertRouteOrdered keeps the default priority groups', () => {
  const match = rule({ id: 'match', type: 'MATCH', payload: '', origin: 'manual' });
  const sourceRule = rule({ id: 'source', type: 'DOMAIN-SUFFIX', payload: 'source.com', origin: 'source', sourceId: 's1' });
  const custom = rule({ id: 'custom', type: 'DOMAIN-SUFFIX', payload: 'custom.com', origin: 'manual' });
  const ruleset = {
    id: 'rs',
    kind: 'ruleset' as const,
    name: 'openai',
    behavior: 'domain' as const,
    format: 'mrs' as const,
    source: { type: 'url' as const, value: 'https://example.com/openai.mrs' },
    inline: false,
    exitId: 'direct',
    enabled: true,
    origin: 'manual' as const,
  };

  let routes = [sourceRule, match] as Route[];
  routes = insertRouteOrdered(routes, custom);
  assert.deepEqual(routes.map((item) => item.id), ['custom', 'source', 'match']);

  routes = insertRouteOrdered(routes, ruleset);
  assert.deepEqual(routes.map((item) => item.id), ['custom', 'rs', 'source', 'match']);

  const newSource = rule({ id: 'source2', type: 'DOMAIN-SUFFIX', payload: 'source2.com', origin: 'source' });
  routes = insertRouteOrdered(routes, newSource);
  assert.deepEqual(routes.map((item) => item.id), ['custom', 'rs', 'source', 'source2', 'match']);
});

test('region detection works for flags and naming conventions', () => {
  assert.equal(detectRegionSafe('🇯🇵 日本 01'), '日本');
  assert.equal(detectRegionSafe('US-Home'), '美国');
  assert.equal(detectRegionSafe('SG-aws'), '新加坡');
  assert.equal(detectRegionSafe('RUS-Moscow'), '俄罗斯');
});

function rule(overrides: Partial<RuleRoute>): RuleRoute {
  return {
    id: 'rule',
    kind: 'rule',
    type: 'DOMAIN-SUFFIX',
    payload: 'example.com',
    exitId: 'direct',
    origin: 'manual',
    enabled: true,
    ...overrides,
  };
}
