import test from 'node:test';
import assert from 'node:assert/strict';
import { assertIsoDate, isValidIsoDate, toIsoDay, todayKolkata, todayUtc } from '../src/common/dates.js';
import { parseJson, validSchema, objectSchema, arraySchema, stringSchema } from '../src/reports/json.js';
import { vaultPath } from '../src/sources/vault.js';

test('dates: isValidIsoDate accepts only real calendar dates in YYYY-MM-DD format', () => {
  assert.equal(isValidIsoDate('2026-10-18'), true);
  assert.equal(isValidIsoDate('2024-02-29'), true, 'leap year date is valid');
  assert.equal(isValidIsoDate('2000-02-29'), true, 'century leap year date is valid');

  // Invalid calendar dates
  assert.equal(isValidIsoDate('2023-02-29'), false, 'non-leap year February 29 must fail');
  assert.equal(isValidIsoDate('2021-04-31'), false, 'April 31 does not exist');
  assert.equal(isValidIsoDate('2023-13-01'), false, 'month 13 does not exist');
  assert.equal(isValidIsoDate('2023-00-10'), false, 'month 00 does not exist');
  assert.equal(isValidIsoDate('2023-05-00'), false, 'day 00 does not exist');
  assert.equal(isValidIsoDate('2023-05-32'), false, 'day 32 does not exist');

  // Format and type violations
  assert.equal(isValidIsoDate(''), false);
  assert.equal(isValidIsoDate(null), false);
  assert.equal(isValidIsoDate(undefined), false);
  assert.equal(isValidIsoDate(12345), false);
  assert.equal(isValidIsoDate('2026/10/18'), false);
  assert.equal(isValidIsoDate('18-10-2026'), false);
  assert.equal(isValidIsoDate('2026-1-1'), false);
  assert.equal(isValidIsoDate('2026-01-01T00:00:00Z'), false);
});

test('dates: assertIsoDate succeeds on valid and throws TypeError on invalid', () => {
  assert.doesNotThrow(() => assertIsoDate('2026-10-18', 'asOf'));
  assert.throws(() => assertIsoDate('2023-02-29', 'asOf'), {
    name: 'TypeError',
    message: /asOf must be an ISO date \(YYYY-MM-DD\)/,
  });
  assert.throws(() => assertIsoDate(null, 'birthDate'), {
    name: 'TypeError',
    message: /birthDate must be an ISO date/,
  });
});

test('dates: toIsoDay extracts YYYY-MM-DD from strings, numbers, or returns null', () => {
  assert.equal(toIsoDay('2026-10-18T14:30:00Z'), '2026-10-18');
  assert.equal(toIsoDay('Sun, 18 Oct 2026 00:00:00 GMT'), '2026-10-18');
  assert.equal(toIsoDay(1792281600000), '2026-10-18');
  assert.equal(toIsoDay(''), null);
  assert.equal(toIsoDay(null), null);
  assert.equal(toIsoDay(undefined), null);
  assert.equal(toIsoDay('not a date'), null);
});

test('dates: todayKolkata and todayUtc return valid ISO dates', () => {
  assert.equal(isValidIsoDate(todayKolkata()), true);
  assert.equal(isValidIsoDate(todayUtc()), true);
});

test('json: validSchema safely validates schemas with missing properties or items', () => {
  // Object schema without properties
  assert.equal(validSchema({ anyField: 123 }, { type: 'object' }), true);
  assert.equal(validSchema({ anyField: 123 }, { type: 'object', additionalProperties: false }), false);
  assert.equal(validSchema(null, { type: 'object' }), false);
  assert.equal(validSchema('not an object', { type: 'object' }), false);
  assert.equal(validSchema([1, 2], { type: 'object' }), false);

  // Array schema without items
  assert.equal(validSchema([1, 'a', {}], { type: 'array' }), true);
  assert.equal(validSchema('not an array', { type: 'array' }), false);
  assert.equal(validSchema([1, 2, 'three'], arraySchema(stringSchema)), false);
  assert.equal(validSchema(['one', 'two'], arraySchema(stringSchema)), true);

  // Primitive schemas
  assert.equal(validSchema('hello', stringSchema), true);
  assert.equal(validSchema(42, { type: 'integer' }), true);
  assert.equal(validSchema(42.5, { type: 'integer' }), false);
  assert.equal(validSchema(42.5, { type: 'number' }), true);
  assert.equal(validSchema('yes', { enum: ['yes', 'no'] }), true);
  assert.equal(validSchema('maybe', { enum: ['yes', 'no'] }), false);

  // Null/undefined guards
  assert.equal(validSchema(null, null), false);
  assert.equal(validSchema(undefined, undefined), false);
  assert.equal(validSchema({}, null), false);
});

test('json: parseJson salvages structured JSON from prose or fences', () => {
  assert.deepEqual(parseJson('{"status": "ok"}'), { status: 'ok' });
  assert.deepEqual(parseJson('Here is your result:\n```json\n{"status": "ok", "n": 1}\n```\nDone!'), { status: 'ok', n: 1 });
  assert.equal(parseJson('invalid json string'), null);
  assert.deepEqual(parseJson({ preParsed: true }), { preParsed: true });
});

test('vault: vaultPath computes safe path and rejects path traversal', () => {
  const sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  assert.equal(vaultPath('/vault', sha), `/vault/${sha.slice(0, 2)}/${sha}`);

  // Test identifiers / mock hashes
  assert.equal(vaultPath('/vault', 'mirrorsha'), '/vault/mi/mirrorsha');
  assert.equal(vaultPath('/vault', 'old'), '/vault/ol/old');

  // Traversal attacks rejected
  assert.throws(() => vaultPath('/vault', '../../etc/passwd'), { name: 'TypeError' });
  assert.throws(() => vaultPath('/vault', '../foo'), { name: 'TypeError' });
  assert.throws(() => vaultPath('/vault', 'a/b'), { name: 'TypeError' });
  assert.throws(() => vaultPath('/vault', 'a\\b'), { name: 'TypeError' });
  assert.throws(() => vaultPath('/vault', 'a'), { name: 'TypeError' }, 'too short');
  assert.throws(() => vaultPath('/vault', ''), { name: 'TypeError' });
  assert.throws(() => vaultPath('/vault', null), { name: 'TypeError' });
});

