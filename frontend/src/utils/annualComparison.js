export const METHODS = Object.freeze(['LSTM', 'ASTGRN', 'STDN', 'reference']);

function validateRange(start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end)
    || start < 1 || end > 20 || start > end) {
    throw new Error('Configuration range must contain integers from pre1 to pre20, with start ≤ end.');
  }
}

export function getConfigurationLabel(start, end) {
  validateRange(start, end);
  return start === end ? `pre${start}` : `pre${start}–pre${end} mean`;
}

function uniqueIntegers(values, name, min, max) {
  if (!Array.isArray(values) || values.length === 0
    || values.some(value => !Number.isInteger(value) || value < min || value > max)
    || new Set(values).size !== values.length) {
    throw new Error(`${name} must be a nonempty list of unique valid integers.`);
  }
  return new Set(values);
}

function validateDataset(dataset, start, end) {
  validateRange(start, end);
  if (!dataset || dataset.schemaVersion !== 1) throw new Error('Unsupported annual comparison dataset.');
  const years = uniqueIntegers(dataset.years, 'Years', 1, 9999);
  const configurations = uniqueIntegers(dataset.configurations, 'Configurations', 1, 20);
  if (!Array.isArray(dataset.methods) || dataset.methods.length !== METHODS.length
    || METHODS.some(method => !dataset.methods.includes(method))) {
    throw new Error('Annual comparison requires LSTM, ASTGRN, STDN, and reference.');
  }
  for (let pre = start; pre <= end; pre += 1) {
    if (!configurations.has(pre)) throw new Error(`Dataset does not contain pre${pre}.`);
  }
  if (!Array.isArray(dataset.regions) || dataset.regions.length !== 2
    || new Set(dataset.regions.map(region => region?.id)).size !== 2
    || !['eastasia', 'focus'].every(id => dataset.regions.some(region => region?.id === id))) {
    throw new Error('Annual comparison requires one East Asia and one focus region.');
  }
  return { years, configurations };
}

/** Average each method's per-configuration correlations with equal weight. */
export function aggregateAnnualComparison(dataset, start, end) {
  const { years, configurations } = validateDataset(dataset, start, end);
  const sortedYears = [...years].sort((a, b) => a - b);
  const configurationCount = end - start + 1;
  return dataset.regions.map(region => {
    if (typeof region.label !== 'string' || !region.label || !Array.isArray(region.points)) {
      throw new Error(`Invalid region ${region.id}.`);
    }
    const indexed = new Map();
    for (const point of region.points) {
      if (!point || !years.has(point.year) || !configurations.has(point.pre)) {
        throw new Error(`Invalid year/configuration record in ${region.id}.`);
      }
      const key = `${point.year}:${point.pre}`;
      if (indexed.has(key)) throw new Error(`Duplicate record for ${region.id}, ${point.year}, pre${point.pre}.`);
      for (const method of METHODS) {
        if (typeof point[method] !== 'number' || !Number.isFinite(point[method])) {
          throw new Error(`Invalid ${method} correlation for ${region.id}, ${point.year}, pre${point.pre}.`);
        }
      }
      indexed.set(key, point);
    }
    const points = sortedYears.map(year => {
      const selected = [];
      for (let pre = start; pre <= end; pre += 1) {
        const point = indexed.get(`${year}:${pre}`);
        if (!point) throw new Error(`Missing record for ${region.id}, ${year}, pre${pre}.`);
        selected.push(point);
      }
      return {
        year,
        ...Object.fromEntries(METHODS.map(method => [
          method,
          selected.reduce((sum, point) => sum + point[method], 0) / configurationCount,
        ])),
        configurationCount,
      };
    });
    return { id: region.id, label: region.label, points };
  });
}

function csvCell(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Export all methods; a chart legend's visibility never changes the data. */
export function buildAnnualComparisonCsv(dataset, start, end, selectedRegion) {
  const allRegions = aggregateAnnualComparison(dataset, start, end);
  if (selectedRegion !== undefined && !allRegions.some(region => region.id === selectedRegion)) {
    throw new Error('Unknown comparison region.');
  }
  const regions = selectedRegion === undefined ? allRegions : allRegions.filter(region => region.id === selectedRegion);
  for (const name of ['run', 'sampleCount', 'casesPerRegion']) {
    if (!Number.isInteger(dataset[name]) || dataset[name] < 1) {
      throw new Error(`Missing or invalid CSV metadata: ${name}.`);
    }
  }
  for (const name of ['referenceDefinition', 'aggregation']) {
    if (typeof dataset[name] !== 'string' || !dataset[name].trim()) {
      throw new Error(`Missing or invalid CSV metadata: ${name}.`);
    }
  }
  const sortedYears = [...dataset.years].sort((a, b) => a - b);
  const rows = [
    ['CIO-input annual model comparison'],
    ['Year scope', sortedYears.join('; ')],
    ['Region scope', regions.map(region => region.label).join('; ')],
    ['Configuration selection', getConfigurationLabel(start, end)],
    ['Configuration start', start],
    ['Configuration end', end],
    ['Configurations averaged', end - start + 1],
    ['Run', dataset.run],
    ['Metric', 'Mean grid-point temporal Pearson r'],
    ['Samples per case', dataset.sampleCount],
    ['Source cases per region', dataset.casesPerRegion],
    ['Selected cases per region', sortedYears.length * (end - start + 1)],
    ['Aggregation', dataset.aggregation],
    ['Reference definition', dataset.referenceDefinition],
    [],
    ['Region', 'Year', 'Configuration count', ...METHODS],
    ...regions.flatMap(region => region.points.map(point => [
      region.id, point.year, point.configurationCount, ...METHODS.map(method => point[method]),
    ])),
  ];
  return `${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
