// beads に倣ったハッシュ ID（ゼロコンフリクト）
import { randomBytes, createHash } from 'node:crypto';

export function newId(prefix) {
  return `${prefix}-${randomBytes(4).toString('hex').slice(0, 6)}`;
}

/** 仮説の重複検出用ハッシュ（表記揺れを正規化） */
export function hypothesisHash(text) {
  const norm = String(text)
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\s、。,.;:!?「」『』()（）\[\]'"`*_-]/gu, '');
  return createHash('sha256').update(norm).digest('hex').slice(0, 16);
}
