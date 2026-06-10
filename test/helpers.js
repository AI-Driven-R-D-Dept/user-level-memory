import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { ensureHome, DEFAULT_CONFIG } from '../src/config.js';

export function freshHome() {
  const home = join(mkdtempSync(join(tmpdir(), 'ulm-test-')), 'ulm');
  ensureHome(home);
  return home;
}

export function withFreshStore(fn) {
  const home = freshHome();
  const store = openStore(home);
  try {
    return fn(store, home);
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
}

export function testConfig(over = {}) {
  return { ...structuredClone(DEFAULT_CONFIG), ...over };
}
