#!/usr/bin/env node
// node:sqlite の ExperimentalWarning だけを抑制する（他の警告は通す）
const origEmit = process.emit;
process.emit = function (name, data, ...rest) {
  if (name === 'warning' && data && data.name === 'ExperimentalWarning' && /SQLite/.test(data.message)) {
    return false;
  }
  return origEmit.call(this, name, data, ...rest);
};

import('../src/cli.js')
  .then(({ main }) => main(process.argv.slice(2)))
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    // 通常はメッセージのみ。デバッグ時のみスタックを出す。
    console.error(`ulm: ${process.env.ULM_DEBUG ? (err?.stack ?? err) : (err?.message ?? err)}`);
    process.exit(1);
  });
