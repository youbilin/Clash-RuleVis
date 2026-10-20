import test from 'node:test';
import assert from 'node:assert/strict';
import { expandRuleset, inspectRuleSetBuffer, sanitizeFileName } from '../rulesets';

test('inspects and expands a domain list', () => {
  const buffer = Buffer.from('# comment\n+.google.com\nfacebook.com\n', 'utf8');
  const inspect = inspectRuleSetBuffer(buffer, { fileName: 'openai.txt' });
  assert.equal(inspect.format, 'text');
  assert.equal(inspect.behavior, 'domain');
  assert.equal(inspect.ruleCount, 2);
  assert.equal(inspect.textAvailable, true);
  const rules = expandRuleset(buffer, 'domain', 'text');
  assert.deepEqual(rules, [
    { type: 'DOMAIN-SUFFIX', payload: 'google.com' },
    { type: 'DOMAIN', payload: 'facebook.com' },
  ]);
});

test('inspects and expands an IP CIDR list', () => {
  const buffer = Buffer.from('1.2.3.0/24\n2001:db8::/32\n', 'utf8');
  const inspect = inspectRuleSetBuffer(buffer, { fileName: 'cn-ip.txt' });
  assert.equal(inspect.behavior, 'ipcidr');
  const rules = expandRuleset(buffer, 'ipcidr', 'text');
  assert.deepEqual(rules, [
    { type: 'IP-CIDR', payload: '1.2.3.0/24', noResolve: true },
    { type: 'IP-CIDR6', payload: '2001:db8::/32', noResolve: true },
  ]);
});

test('classical rulesets override the target and preserve no-resolve', () => {
  const buffer = Buffer.from(
    'DOMAIN-SUFFIX,example.com,DIRECT\nIP-CIDR,10.0.0.0/8,REJECT,no-resolve\n',
    'utf8',
  );
  const inspect = inspectRuleSetBuffer(buffer, { fileName: 'custom.txt' });
  assert.equal(inspect.behavior, 'classical');
  const rules = expandRuleset(buffer, 'classical', 'text');
  assert.deepEqual(rules, [
    { type: 'DOMAIN-SUFFIX', payload: 'example.com', noResolve: undefined },
    { type: 'IP-CIDR', payload: '10.0.0.0/8', noResolve: true },
  ]);
});

test('YAML payload lists are supported', () => {
  const buffer = Buffer.from("payload:\n  - '+.google.com'\n  - 'facebook.com'\n", 'utf8');
  const inspect = inspectRuleSetBuffer(buffer, { fileName: 'google.yaml' });
  assert.equal(inspect.format, 'yaml');
  assert.equal(inspect.ruleCount, 2);
  assert.deepEqual(expandRuleset(buffer, 'domain', 'yaml'), [
    { type: 'DOMAIN-SUFFIX', payload: 'google.com' },
    { type: 'DOMAIN', payload: 'facebook.com' },
  ]);
});

test('MRS files are binary and cannot be inlined', () => {
  const buffer = Buffer.from('not really a rule set', 'utf8');
  const inspect = inspectRuleSetBuffer(buffer, { fileName: 'openai.mrs' });
  assert.equal(inspect.format, 'mrs');
  assert.equal(inspect.textAvailable, false);
  assert.throws(() => expandRuleset(buffer, 'domain', 'mrs'), /MRS/);
});

test('sanitizeFileName strips paths', () => {
  assert.equal(sanitizeFileName('../evil.mrs'), 'evil.mrs');
  assert.equal(sanitizeFileName(''), 'ruleset.txt');
});
