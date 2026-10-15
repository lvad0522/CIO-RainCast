import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  METHODS, aggregateAnnualComparison, buildAnnualComparisonCsv, getConfigurationLabel,
} from '../src/utils/annualComparison.js';

function fixture() {
  return {
    schemaVersion: 1,
    years: [2001, 2000],
    configurations: [1, 2, 20],
    methods: [...METHODS],
    run: 1,
    sampleCount: 112,
    casesPerRegion: 6,
    referenceDefinition: 'Per-grid reference, calculated "independently"',
    aggregation: 'Arithmetic mean of per-configuration correlations',
    regions: ['eastasia', 'focus'].map((id, regionIndex) => ({
      id,
      label: id === 'eastasia' ? 'East Asia' : 'Focus region',
      points: [2000, 2001].flatMap(year => [1, 2, 20].map(pre => ({
        year,
        pre,
        LSTM: 0.01 * pre + 0.1 * regionIndex + 0.001 * (year - 2000),
        ASTGRN: 0.1234567890123456 + 0.01 * pre + 0.1 * regionIndex,
        STDN: -0.01 * pre - 0.1 * regionIndex,
        reference: 0.02 * pre - 0.1 * regionIndex,
        // Different counts must not change the equal configuration weighting.
        validGridPoints: pre === 1 ? 1000 : 1,
      }))),
    })),
  };
}

test('annual means give each selected configuration equal weight in both regions', () => {
  const data = fixture();
  const result = aggregateAnnualComparison(data, 1, 2);
  assert.deepEqual(result.map(region => region.id), ['eastasia', 'focus']);
  assert.deepEqual(result[0].points.map(point => point.year), [2000, 2001]);
  for (let region = 0; region < 2; region += 1) {
    const source = data.regions[region].points.filter(point => point.year === 2000 && point.pre <= 2);
    for (const method of METHODS) {
      assert.equal(result[region].points[0][method], (source[0][method] + source[1][method]) / 2);
    }
    assert.equal(result[region].points[0].configurationCount, 2);
  }
  assert.equal(result[0].points[0].LSTM, 0.015);
  assert.deepEqual(data, fixture(), 'aggregation must not mutate the source data');
});

test('fixed 140-case annual export retains three models and the diagnostic reference', () => {
  const data = JSON.parse(readFileSync(new URL('../src/data/annualModelComparison.json', import.meta.url), 'utf8'));
  const csv = buildAnnualComparisonCsv(data, 1, 7, 'focus');
  assert.ok(csv.includes('Selected cases per region,140\r\n'));
  assert.ok(csv.includes('Region,Year,Configuration count,LSTM,ASTGRN,STDN,reference\r\n'));
  assert.equal(csv.split('\r\n').filter(row => /^focus,\d{4},/.test(row)).length, 20);
  assert.ok(csv.includes('Reference definition,'));
});

test('single configuration selection and pre20 preserve the source correlations', () => {
  const data = fixture();
  for (const pre of [1, 2, 20]) {
    const result = aggregateAnnualComparison(data, pre, pre);
    for (let region = 0; region < 2; region += 1) {
      for (const annual of result[region].points) {
        const source = data.regions[region].points.find(point => point.year === annual.year && point.pre === pre);
        for (const method of METHODS) assert.equal(annual[method], source[method]);
        assert.equal(annual.configurationCount, 1);
      }
    }
  }
  assert.equal(getConfigurationLabel(20, 20), 'pre20');
  assert.equal(getConfigurationLabel(1, 7), 'pre1–pre7 mean');
});

test('invalid ranges and unavailable configuration selections fail explicitly', () => {
  for (const [start, end] of [[0, 1], [1, 21], [2, 1], [1.5, 2], ['1', 2], [NaN, 2], [1, Infinity]]) {
    assert.throws(() => aggregateAnnualComparison(fixture(), start, end), /Configuration range/);
    assert.throws(() => getConfigurationLabel(start, end), /Configuration range/);
  }
  assert.throws(() => aggregateAnnualComparison(fixture(), 1, 3), /does not contain pre3/);
});

test('a missing selected record in either region cannot be silently dropped or reused', () => {
  for (const id of ['eastasia', 'focus']) {
    const data = fixture();
    const region = data.regions.find(entry => entry.id === id);
    region.points = region.points.filter(point => !(point.year === 2001 && point.pre === 2));
    assert.throws(() => aggregateAnnualComparison(data, 1, 2), new RegExp(`Missing record for ${id}, 2001, pre2`));
  }
});

test('duplicate records and invalid model correlations are rejected', () => {
  const duplicate = fixture();
  duplicate.regions[0].points.push({ ...duplicate.regions[0].points[0] });
  assert.throws(() => aggregateAnnualComparison(duplicate, 1, 2), /Duplicate record/);
  for (const invalid of [null, undefined, NaN, Infinity, -Infinity, '0.2']) {
    for (const method of METHODS) {
      const data = fixture();
      data.regions[1].points[0][method] = invalid;
      assert.throws(() => aggregateAnnualComparison(data, 1, 2), new RegExp(`Invalid ${method} correlation`));
    }
  }
});

test('invalid dataset identities cannot masquerade as complete data', () => {
  for (const change of [
    data => { data.years.push(2000); },
    data => { data.configurations.push(1); },
    data => { data.methods[3] = 'ASTGRN'; },
    data => { data.regions[1].id = 'eastasia'; },
    data => { data.regions[1].points[0].year = 1999; },
    data => { data.regions[0].points[0].pre = 19; },
  ]) {
    const data = fixture();
    change(data);
    assert.throws(() => aggregateAnnualComparison(data, 1, 2));
  }
});

test('CSV records selected scope, provenance, and all four unrounded values', () => {
  const data = fixture();
  const csv = buildAnnualComparisonCsv(data, 20, 20);
  assert.ok(csv.includes('Configuration selection,pre20\r\n'));
  assert.ok(csv.includes('Configuration start,20\r\nConfiguration end,20\r\n'));
  assert.ok(csv.includes('Year scope,2000; 2001\r\n'));
  assert.ok(csv.includes('Run,1\r\n'));
  assert.ok(csv.includes('Metric,Mean grid-point temporal Pearson r\r\n'));
  assert.ok(csv.includes('Source cases per region,6\r\nSelected cases per region,2\r\n'));
  assert.ok(csv.includes('Reference definition,"Per-grid reference, calculated ""independently"""\r\n'));
  assert.ok(csv.includes('Region,Year,Configuration count,LSTM,ASTGRN,STDN,reference\r\n'));
  const annual = aggregateAnnualComparison(data, 20, 20);
  for (const region of annual) {
    for (const point of region.points) {
      assert.ok(csv.includes([region.id, point.year, 1, ...METHODS.map(method => point[method])].join(',')));
    }
  }
  const ranged = buildAnnualComparisonCsv(data, 1, 2);
  assert.ok(ranged.includes('Configuration selection,pre1–pre2 mean\r\n'));
  assert.ok(ranged.includes('Configurations averaged,2\r\n'));
  assert.ok(ranged.includes('Selected cases per region,4\r\n'));
});

test('CSV rejects missing provenance rather than exporting an undefined label', () => {
  for (const name of ['run', 'sampleCount', 'casesPerRegion', 'referenceDefinition', 'aggregation']) {
    const data = fixture();
    delete data[name];
    assert.throws(() => buildAnnualComparisonCsv(data, 1, 2), /CSV metadata/);
  }
});

test('region-selected CSV contains the displayed region and its full-precision annual scores', () => {
  const data = fixture();
  for (const selected of ['focus', 'eastasia']) {
    const csv = buildAnnualComparisonCsv(data, 1, 2, selected);
    const expected = aggregateAnnualComparison(data, 1, 2).find(region => region.id === selected);
    assert.ok(csv.includes(`Region scope,${expected.label}\r\n`));
    const lines = csv.split('\r\n').filter(line => /^(focus|eastasia),/.test(line));
    assert.deepEqual(lines, expected.points.map(point => [
      selected, point.year, 2, ...METHODS.map(method => point[method]),
    ].join(',')));
  }
  assert.throws(() => buildAnnualComparisonCsv(data, 1, 2, 'unknown'), /Unknown comparison region/);
});

test('bundled annual data covers all 400 cases per region and the full pre1–pre20 range', () => {
  const data = JSON.parse(readFileSync(new URL('../src/data/annualModelComparison.json', import.meta.url), 'utf8'));
  assert.deepEqual(data.years, Array.from({ length: 20 }, (_, index) => 2000 + index));
  assert.deepEqual(data.configurations, Array.from({ length: 20 }, (_, index) => 1 + index));
  assert.deepEqual(data.methods, METHODS);
  assert.equal(data.run, 1);
  assert.equal(data.sampleCount, 112);
  assert.equal(data.casesPerRegion, 400);
  assert.equal(data.source.productCount, 2400);
  assert.equal(data.source.approvedFigureMaxAbsoluteError, 0);
  assert.match(data.referenceDefinition, /other 19.*excluding the evaluated year/);
  for (const region of data.regions) {
    assert.equal(region.points.length, 400);
    for (const point of region.points) {
      assert.ok(Number.isInteger(point.validGridPoints) && point.validGridPoints > 0);
      assert.ok(point.validGridPoints <= (region.id === 'eastasia' ? 81 * 101 : 17 * 37));
      for (const method of METHODS) assert.ok(point[method] >= -1 && point[method] <= 1);
    }
  }
  const all = aggregateAnnualComparison(data, 1, 20);
  for (const region of all) {
    assert.equal(region.points.length, 20);
    assert.ok(region.points.every(point => point.configurationCount === 20));
  }
  const endpoint = aggregateAnnualComparison(data, 20, 20);
  for (const region of endpoint) {
    for (const point of region.points) {
      const source = data.regions.find(entry => entry.id === region.id).points
        .find(entry => entry.year === point.year && entry.pre === 20);
      for (const method of METHODS) assert.equal(point[method], source[method]);
    }
  }
});

test('pre1–pre7 aggregation preserves independently frozen original-figure values', () => {
  const data = JSON.parse(readFileSync(new URL('../src/data/annualModelComparison.json', import.meta.url), 'utf8'));
  const eastAsia = aggregateAnnualComparison(data, 1, 7).find(region => region.id === 'eastasia');
  // These values come from the original reviewer-B diagnostic, not this utility.
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-14, `${actual} ≠ ${expected}`);
  close(eastAsia.points.find(point => point.year === 2000).LSTM, 0.14875837552959664);
  close(eastAsia.points.find(point => point.year === 2001).LSTM, 0.12576220399846932);
  close(eastAsia.points.reduce((sum, point) => sum + point.LSTM, 0) / 20, 0.1283555067812275);
  close(eastAsia.points.reduce((sum, point) => sum + point.ASTGRN, 0) / 20, 0.1747921717330181);
});
