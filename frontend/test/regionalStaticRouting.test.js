import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('static routing serves matching four-curve cases for both regions and pre20', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    location: { href: 'http://demo.local/', origin: 'http://demo.local' },
    fetch: async url => {
      const path = new URL(url, 'http://demo.local/').pathname;
      const bytes = await readFile(new URL(`../public${path}`, import.meta.url));
      return new Response(bytes, { headers: { 'Content-Type': 'application/json' } });
    },
  };
  try {
    const { resolveApi, setStaticMode } = await import('../src/staticMode.js');
    setStaticMode(true);
    for (const [year, lead, region] of [[2018, 5, 'focus'], [2018, 5, 'eastasia'], [2019, 20, 'focus']]) {
      const response = await resolveApi(new URL(`http://demo.local/api/regional-model-series?year=${year}&lead=${lead}&region=${region}`));
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.year, year);
      assert.equal(payload.lead, lead);
      assert.equal(payload.region.id, region);
      assert.equal(payload.samples.length, 112);
    }
    const invalid = await resolveApi(new URL('http://demo.local/api/regional-model-series?year=2018&lead=21&region=focus'));
    assert.equal(invalid.status, 422);
    setStaticMode(false);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
