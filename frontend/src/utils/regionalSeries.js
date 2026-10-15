export const REGIONAL_MODELS = Object.freeze(['LSTM', 'ASTGRN', 'STDN']);
export const REGIONAL_SERIES = Object.freeze(['observation', ...REGIONAL_MODELS]);

export function normalizeRegionalSelection({ year, lead, region }) {
  const selectedYear = Number(year);
  const selectedLead = Number(String(lead).replace(/^pre/, ''));
  if (!Number.isInteger(selectedYear) || selectedYear < 2000 || selectedYear > 2019
    || !Number.isInteger(selectedLead) || selectedLead < 1 || selectedLead > 20
    || !['focus', 'eastasia'].includes(region)) {
    throw new Error('Select a year from 2000–2019, pre1–pre20, and a rainfall region.');
  }
  return { year: selectedYear, lead: selectedLead, region };
}

export function validateRegionalSeries(payload, selection) {
  const selected = normalizeRegionalSelection(selection);
  if (payload?.schemaVersion !== 1 || payload.year !== selected.year || payload.lead !== selected.lead
    || payload.configuration !== `pre${selected.lead}` || payload.region?.id !== selected.region
    || payload.run !== 1 || payload.retainedSamples !== 112
    || !Array.isArray(payload.samples) || payload.samples.length !== 112
    || payload.samples.some((sample, index) => sample.index !== index + 1
      || typeof sample.date !== 'string' || !sample.date.startsWith(`${selected.year}-`)
      || REGIONAL_SERIES.some(method => !Number.isFinite(sample[method])))
    || !Array.isArray(payload.metrics) || payload.metrics.length !== REGIONAL_MODELS.length
    || REGIONAL_MODELS.some(model => {
      const matches = payload.metrics.filter(row => row.model === model);
      return matches.length !== 1 || matches[0].sampleCount !== 112
        || (matches[0].r !== null && (!Number.isFinite(matches[0].r) || Math.abs(matches[0].r) > 1.0000001))
        || ['rmse', 'mae'].some(metric => !Number.isFinite(matches[0][metric]) || matches[0][metric] < 0);
    })) {
    throw new Error('Regional time series do not match the selected case or contain incomplete values.');
  }
  return payload;
}

export async function loadRegionalSeries(selection, {
  apiBase = '', bakedBase = '/demo-data/', signal, fetchImpl = fetch,
} = {}) {
  const selected = normalizeRegionalSelection(selection);
  const query = new URLSearchParams(selected);
  let response;
  try {
    response = await fetchImpl(`${apiBase}/api/regional-model-series?${query}`, { signal });
  } catch (reason) {
    if (reason.name === 'AbortError' || signal?.aborted) throw reason;
  }
  if (!response || response.status === 404) {
    response = await fetchImpl(`${bakedBase}regional-model-series/${selected.year}-pre${selected.lead}_${selected.region}.json`, { signal });
  }
  const payload = await response.json();
  if (!response.ok) throw new Error(typeof payload.detail === 'string'
    ? payload.detail : `Regional time series unavailable (${response.status}).`);
  return validateRegionalSeries(payload, selected);
}

export function buildRegionalSeriesCsv(payload) {
  validateRegionalSeries(payload, { year: payload.year, lead: payload.lead, region: payload.region?.id });
  const rows = [
    ['Regional-mean rainfall time series'],
    ['Year', payload.year], ['Input-window configuration', payload.configuration],
    ['Region', payload.region.id], ['Run', payload.run], ['Samples', payload.retainedSamples], ['Units', 'mm/day'],
    [], ['Model', 'Regional-mean series Pearson r', 'Regional-mean series RMSE', 'Regional-mean series MAE'],
    ...payload.metrics.map(row => [row.model, row.r ?? '', row.rmse, row.mae]),
    [], ['Retained sample', 'Target date', 'Observation', ...REGIONAL_MODELS],
    ...payload.samples.map(row => [row.index, row.date, ...REGIONAL_SERIES.map(method => row[method])]),
  ];
  const cell = value => /[",\r\n]/.test(String(value)) ? `"${String(value).replaceAll('"', '""')}"` : String(value);
  return `${rows.map(row => row.map(cell).join(',')).join('\r\n')}\r\n`;
}
