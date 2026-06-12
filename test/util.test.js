import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTtl, truncate, splitCsv, shortDate, parseJsonSafe, trigramContainment } from '../src/util.js';
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

test('trigramContainment: 警告用の弱フィルタとして実測ペアを拾う', () => {
  // 実測した真の重複ペア（0.44-0.54）が閾値 0.4 で拾えること
  const dup = trigramContainment(
    'ユーザーは野菜が嫌いと本人が明言（食べ物の好み）。食事・レシピ・店選びの話題に関連する',
    'ユーザーは野菜が嫌い。食事・レシピ・店選びの提案時は、野菜中心の提案を避けるのが無難。'
  );
  assert.ok(dup >= 0.4, `真の重複が閾値を超える: ${dup}`);
  // 無関係テキストは拾わない
  const unrelated = trigramContainment('GitHub README は mp4 をインライン再生できない', 'ユーザーは野菜が嫌い');
  assert.ok(unrelated < 0.4, `無関係は閾値未満: ${unrelated}`);
  // 端ケース: 短すぎる・空
  assert.equal(trigramContainment('', 'abc'), 0);
  assert.equal(trigramContainment('ab', 'ab'), 0);
});
