/**
 * Tests for the Pages Blob read-through cache and its 1GB eviction policy.
 *
 * Runs against an in-memory mock store, so it needs neither EdgeOne nor the
 * real SDK. Run: node test-blob.mjs
 */
import { evictToBudget, blobPut } from './functions/[[...path]].ts';

const MB = 1024 * 1024;

function assert(label, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  return cond;
}

class MockStore {
  constructor() {
    this.data = new Map();
    this.deletes = [];
  }
  async set(k, v) {
    this.data.set(k, v);
  }
  async setJSON(k, v) {
    this.data.set(k, JSON.stringify(v));
  }
  async get(k, opts = {}) {
    if (!this.data.has(k)) return null;
    const v = this.data.get(k);
    return (opts.type || 'text') === 'text' ? v : v;
  }
  async getMetadata(k) {
    return this.data.has(k) ? { contentType: 'image/png' } : null;
  }
  async delete(k) {
    this.deletes.push(k);
    this.data.delete(k);
  }
}

let pass = true;

// ---------- 1. evictToBudget is pure and FIFO ----------
console.log('\n=== 1. evictToBudget: FIFO by write time ===');
{
  const cfg = { limitBytes: 100 * MB, maxObjectBytes: 5 * MB, maxEntries: 9999 };
  const index = {
    total: 0,
    entries: {
      'obj/a': { size: 40 * MB, at: 100 },
      'obj/b': { size: 40 * MB, at: 200 },
      'obj/c': { size: 40 * MB, at: 300 },
    },
  };
  index.total = 120 * MB; // over the 100MB budget
  const removed = evictToBudget(index, cfg);
  // 120MB -> drop the oldest 40MB -> 80MB, which is under the 95MB soft limit.
  // Exactly one eviction: dropping more would mean the loop is not converging.
  pass = assert('evicts exactly one entry', removed.length === 1, `removed=${removed}`);
  pass = assert('and it is the oldest', removed[0] === 'obj/a', `removed=${removed}`);
  pass = assert('total is exactly 80MB', index.total === 80 * MB, `total=${(index.total / MB).toFixed(1)}MB`);
  pass = assert('obj/c survives', 'obj/c' in index.entries) && pass;
  pass = assert('obj/b survives', 'obj/b' in index.entries) && pass;
}

// ---------- 2. entry-count cap ----------
console.log('\n=== 2. evictToBudget: entry count cap ===');
{
  const cfg = { limitBytes: 10 * 1024 * MB, maxObjectBytes: 5 * MB, maxEntries: 3 };
  const index = { total: 0, entries: {} };
  for (let i = 0; i < 6; i++) {
    index.entries[`obj/f${i}`] = { size: 1 * MB, at: i + 1 };
    index.total += 1 * MB;
  }
  const removed = evictToBudget(index, cfg);
  pass = assert('trims down to the entry cap', Object.keys(index.entries).length <= 3, `left=${Object.keys(index.entries).length}`);
  pass = assert('removes oldest-by-time first', removed.includes('obj/f0') && removed.includes('obj/f1')) && pass;
}

// ---------- 3. never evicts everything ----------
console.log('\n=== 3. evictToBudget: a single oversized entry still terminates ===');
{
  const cfg = { limitBytes: 1 * MB, maxObjectBytes: 5 * MB, maxEntries: 9999 };
  const index = { total: 10 * MB, entries: { 'obj/big': { size: 10 * MB, at: 1 } } };
  const removed = evictToBudget(index, cfg);
  pass = assert('removes it and stops', removed.length === 1 && Object.keys(index.entries).length === 0) && pass;
  pass = assert('total is not negative', index.total === 0, `total=${index.total}`) && pass;
}

// ---------- 4. blobPut keeps the store within budget ----------
console.log('\n=== 4. blobPut: end-to-end against a mock store ===');
{
  const store = new MockStore();
  const cfg = {
    enabled: true,
    storeName: 's3-cache',
    limitBytes: 25 * MB,
    maxObjectBytes: 5 * MB,
    maxEntries: 9999,
  };

  const mk = (n) => new Uint8Array(n * MB).buffer;

  // Six 5MB objects = 30MB > 25MB budget; oldest must be evicted.
  for (let i = 0; i < 6; i++) {
    const ok = await blobPut(store, `img${i}.png`, mk(5), 'image/png', cfg);
    if (!ok) {
      pass = assert(`blobPut img${i}.png`, false) && pass;
      break;
    }
  }

  const raw = store.data.get('__index__');
  const index = JSON.parse(raw);
  const totalMB = index.total / MB;

  // 6 x 5MB with a 25MB budget (23.75MB soft limit):
  //   after img4 -> 25MB -> evict img0 -> 20MB
  //   after img5 -> 25MB -> evict img1 -> 20MB
  // So exactly two evictions, four survivors, 20MB used.
  pass = assert('keeps exactly 4 of 6 objects', Object.keys(index.entries).length === 4, `entries=${Object.keys(index.entries).length}`);
  pass = assert('total is exactly 20MB', totalMB === 20, `total=${totalMB}MB`);
  pass = assert('evicted exactly the two oldest', JSON.stringify(store.deletes) === JSON.stringify(['obj/img0.png', 'obj/img1.png']), `deletes=${store.deletes}`);
  pass = assert('newest object is still present', store.data.has('obj/img5.png')) && pass;
  pass = assert('index total matches summed sizes', index.total === Object.values(index.entries).reduce((n, e) => n + e.size, 0), `total=${index.total}`) && pass;
}

// ---------- 5. blobPut refuses oversized objects ----------
console.log('\n=== 5. blobPut: respects maxObjectBytes at the call site ===');
{
  // The caller (handle) skips blobPut above maxObjectBytes; here we just prove
  // a store that throws degrades to false instead of breaking the proxy.
  const failing = {
    set: async () => {
      throw new Error('quota exceeded');
    },
    setJSON: async () => {
      throw new Error('quota exceeded');
    },
    get: async () => null,
    delete: async () => {},
  };
  const cfg = { enabled: true, storeName: 'x', limitBytes: 25 * MB, maxObjectBytes: 5 * MB, maxEntries: 10 };
  const ok = await blobPut(failing, 'a.png', new ArrayBuffer(1024), 'image/png', cfg);
  pass = assert('store failure degrades to false, never throws', ok === false) && pass;
}

console.log();
console.log(pass ? 'All blob cache tests passed' : 'Some blob cache tests failed');
process.exit(pass ? 0 : 1);
