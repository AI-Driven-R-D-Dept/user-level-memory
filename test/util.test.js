import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTtl, truncate, splitCsv, shortDate, parseJsonSafe } from '../src/util.js';
import { newId, hypothesisHash } from '../src/ids.js';

test('parseTtl: 各単位', () => {
  assert.equal(parseTtl('30m'), 30 * 60_000);
  assert.equal(parseTtl('24h'), 24 * 3_600_000);
  assert.equal(parseTtl('7d'), 7 * 86_400_000);
  assert.equal(parseTtl('2w'), 2 * 604_800_000);
  assert.equal(parseTtl('bad'), null);
  assert.equal(parseTtl('10x'), null);
});

test('truncate: 上限で切る', () => {
  assert.equal(truncate('hello', 10), 'hello');
  assert.equal(truncate('hello world', 5), 'hell…');
});

test('splitCsv: トリムと空除去', () => {
  assert.deepEqual(splitCsv('a, b ,,c'), ['a', 'b', 'c']);
  assert.deepEqual(splitCsv(''), []);
  assert.deepEqual(splitCsv(undefined), []);
});

test('shortDate: ISO を日付に', () => {
  assert.equal(shortDate('2026-06-10T12:34:56.000Z'), '2026-06-10');
});

test('parseJsonSafe: 不正は fallback', () => {
  assert.deepEqual(parseJsonSafe('{"a":1}', null), { a: 1 });
  assert.equal(parseJsonSafe('not json', 'fb'), 'fb');
});

test('newId: prefix とフォーマット', () => {
  const id = newId('obs');
  assert.match(id, /^obs-[0-9a-f]{6}$/);
  assert.notEqual(newId('x'), newId('x')); // ランダム性
});

test('hypothesisHash: 表記揺れを正規化', () => {
  assert.equal(hypothesisHash('赤ボタンが有効'), hypothesisHash('赤ボタンが有効。'));
  assert.equal(hypothesisHash('A B C'), hypothesisHash('a　b　c')); // 全角空白/大小
  assert.notEqual(hypothesisHash('赤'), hypothesisHash('青'));
});
