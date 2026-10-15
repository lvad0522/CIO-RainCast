import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildRegionalSeriesCsv, loadRegionalSeries, normalizeRegionalSelection, validateRegionalSeries } from '../src/utils/regionalSeries.js';
import { initialCase, initialComparisonRegion } from '../src/utils/caseSelection.js';

const selection = { year: 2018, lead: 'pre5', region: 'focus' };
const fixture = () => JSON.parse(readFileSync(new URL('../public/demo-data/regional-model-series/2018-pre5_focus.json', import.meta.url), 'utf8'));

test('default and URL case selections preserve 2018/pre5 and allow pre1–pre20 exploration', () => {
  assert.deepEqual(initialCase(), { predYear: 2018, leadTime: 'pre5', predRegion: 'eastasia' });
  assert.deepEqual(initialCase('?year=2000&pre=20'), { predYear: 2000, leadTime: 'pre20', predRegion: 'eastasia' });
  assert.equal(initialCase('?year=2099&lead=pre99').predYear, 2018);
  assert.equal(initialCase('?year=2099&lead=pre99').leadTime, 'pre5');
  assert.equal(initialComparisonRegion('?region=eastasia'), 'eastasia');
  assert.equal(initialComparisonRegion('?region=elsewhere'), 'focus');
  assert.deepEqual(normalizeRegionalSelection(selection), { year: 2018, lead: 5, region: 'focus' });
});

test('a stale case, wrong region, partial series or duplicated model cannot populate the current chart', () => {
  assert.equal(validateRegionalSeries(fixture(), selection).samples.length, 112);
  for (const mutate of [
    data => { data.year = 2017; },
    data => { data.lead = 6; },
    data => { data.region.id = 'eastasia'; },
    data => { data.samples.pop(); },
    data => { data.samples[0].index = 2; },
    data => { data.samples[5].STDN = null; },
    data => { data.metrics[0].model = 'ASTGRN'; },
  ]) {
    const data = fixture();
    mutate(data);
    assert.throws(() => validateRegionalSeries(data, selection), /do not match/);
  }
});

test('an older backend falls back to the exact selected baked response', async () => {
  const requests = [];
  const payload = await loadRegionalSeries(selection, { fetchImpl: async url => {
    requests.push(url);
    return requests.length === 1 ? new Response('{}', { status: 404 }) : Response.json(fixture());
  } });
  assert.equal(payload.configuration, 'pre5');
  assert.equal(requests[1], '/demo-data/regional-model-series/2018-pre5_focus.json');
  assert.ok(requests[0].includes('year=2018&lead=5&region=focus'));
});

test('truth conflicts and aborted selections are not hidden by a static fallback', async () => {
  let count = 0;
  await assert.rejects(loadRegionalSeries(selection, { fetchImpl: async () => {
    count += 1;
    return Response.json({ detail: 'Stored observations differ.' }, { status: 409 });
  } }), /observations differ/);
  assert.equal(count, 1);
  await assert.rejects(loadRegionalSeries(selection, { fetchImpl: async () => {
    throw new DOMException('Selection changed', 'AbortError');
  } }), { name: 'AbortError' });
});

test('default curve metrics independently match the four plotted series after spatial averaging', () => {
  for (const region of ['focus', 'eastasia']) {
    const data = JSON.parse(readFileSync(new URL(`../public/demo-data/regional-model-series/2018-pre5_${region}.json`, import.meta.url), 'utf8'));
    validateRegionalSeries(data, { ...selection, region });
    const observation = data.samples.map(row => row.observation);
    const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
    for (const row of data.metrics) {
      const prediction = data.samples.map(sample => sample[row.model]);
      const errors = prediction.map((value, i) => value - observation[i]);
      const p = prediction.map(value => value - mean(prediction));
      const o = observation.map(value => value - mean(observation));
      const r = p.reduce((sum, value, i) => sum + value * o[i], 0)
        / Math.sqrt(p.reduce((sum, value) => sum + value * value, 0) * o.reduce((sum, value) => sum + value * value, 0));
      assert.ok(Math.abs(row.r - r) < 1e-12);
      assert.ok(Math.abs(row.rmse - Math.sqrt(mean(errors.map(value => value * value)))) < 1e-12);
      assert.ok(Math.abs(row.mae - mean(errors.map(Math.abs))) < 1e-12);
    }
  }
});

test('CSV always exports all four curves, all 112 dates and their separate regional-series metrics', () => {
  const data = fixture();
  const csv = buildRegionalSeriesCsv(data);
  assert.ok(csv.includes('Input-window configuration,pre5\r\n'));
  assert.ok(csv.includes('Retained sample,Target date,Observation,LSTM,ASTGRN,STDN\r\n'));
  assert.equal(csv.split('\r\n').filter(row => /^\d+,2018-/.test(row)).length, 112);
  assert.ok(csv.includes(`1,2018-06-02,${data.samples[0].observation},${data.samples[0].LSTM}`));
  assert.ok(csv.includes('112,2018-09-29,'));
});
