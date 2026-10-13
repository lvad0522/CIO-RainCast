import { useEffect, useState } from 'react';
import {
  CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';

const MODELS = ['LSTM', 'ASTGRN', 'STDN'];
const MODEL_STYLES = {
  LSTM: { color: '#D55E00', width: 2.5 },
  ASTGRN: { color: '#0072B2', width: 3 },
  STDN: { color: '#009E73', width: 2.5 },
};

function formatMetric(value, digits = 4) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function csvCell(value) {
  if (value == null || (typeof value === 'number' && !Number.isFinite(value))) return '';
  const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(serialized) ? `"${serialized.replaceAll('"', '""')}"` : serialized;
}

function buildComparisonCsv(data) {
  const metadata = [
    ['Metadata', 'Value'],
    ['Year (table)', data.year],
    ['Lead (table)', data.lead],
    ['Region', data.region],
    ['Region label', data.regionLabel],
    ['Curve scope', data.scope],
    ['Curve aggregation', data.scope === 'all' ? 'Equal-weight mean of paired years at each lead' : 'Selected year'],
    ['Run', 1],
    ['Correlation metric', data.metric || 'mean_gridpoint_r'],
    ['Definition', data.definition],
    ['Error metric definition', 'RMSE and MAE pooled over paired grid points and time samples'],
    ['Samples (table)', data.sampleCount],
    ['Valid grid points (table)', data.validGridPoints],
    ['Region grid points', data.regionGridPoints],
    ['Paired finite grid-time values (table)', data.validSamplePairs],
    ['Paired finite time steps (table)', data.validTimeSteps],
    ['Source', data.source],
    ...Object.entries(data.coverage || {}).map(([key, value]) => [`Coverage: ${key}`, value]),
  ];
  const rows = [
    ...metadata, [],
    ['Model (current year and lead)', 'Mean grid-point r', 'RMSE (mm/day)', 'MAE (mm/day)', 'Run'],
    ...(data.rows || []).map(row => [row.model, row.meanGridR, row.rmse, row.mae, row.fold ?? 1]),
    [], ['Lead', 'LSTM mean grid-point r', 'ASTGRN mean grid-point r', 'STDN mean grid-point r'],
    ...(data.curve || []).map(point => [point.lead, point.LSTM, point.ASTGRN, point.STDN]),
  ];
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}

function exportComparison(data) {
  const blob = new Blob(['\uFEFF', buildComparisonCsv(data)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `cio_model_comparison_${data.year}_pre${data.lead}_${data.region}_${data.scope}_run1.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function curveCoverage(data) {
  const years = data.coverage?.years || [];
  const available = data.coverage?.availableCases;
  const total = data.coverage?.totalCases;
  const yearLabel = years.length > 1
    ? `${Math.min(...years)}–${Math.max(...years)}` : String(years[0] ?? data.year);
  return {
    yearLabel,
    text: Number.isFinite(available) && Number.isFinite(total)
      ? `${available}/${total} paired cases available` : '',
  };
}

export default function CioModelComparison({ year, lead, apiBase = '' }) {
  const [region, setRegion] = useState('focus');
  const [scope, setScope] = useState('year');
  const [retry, setRetry] = useState(0);
  const [response, setResponse] = useState({ key: '', status: 'loading', data: null, error: '' });
  const leadNumber = Number.parseInt(String(lead).replace(/^pre/, ''), 10);
  const query = new URLSearchParams({ year, lead: leadNumber, region, scope }).toString();
  const requestKey = `${apiBase}|${query}|${retry}`;

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const result = await fetch(`${apiBase}/api/model-comparison?${query}`, { signal: controller.signal });
        const payload = await result.json();
        if (!result.ok) {
          throw new Error(typeof payload.detail === 'string'
            ? payload.detail : `Unable to load model comparison (${result.status}).`);
        }
        if (!controller.signal.aborted) {
          setResponse({ key: requestKey, status: 'ready', data: payload, error: '' });
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          setResponse({ key: requestKey, status: 'error', data: null, error: reason.message });
        }
      }
    }
    load();
    return () => controller.abort();
  }, [apiBase, query, requestKey]);

  // A new selection never displays a previous year's metrics while its request is pending.
  const current = response.key === requestKey;
  const loading = !current || response.status === 'loading';
  const data = current && response.status === 'ready' ? response.data : null;
  const rows = MODELS.map(model => data?.rows?.find(row => row.model === model));
  const hasRows = rows.some(Boolean);
  const hasCurve = data?.curve?.some(point => MODELS.some(model => Number.isFinite(point[model])));
  const coverage = data ? curveCoverage(data) : null;
  const curveValues = (data?.curve || []).flatMap(point => MODELS.map(model => point[model])).filter(Number.isFinite);
  // Include zero while keeping the model curves legible in a compact card.
  const curveDomain = curveValues.length ? [
    Math.max(-1, Math.min(0, Math.floor((Math.min(...curveValues) - .05) * 10) / 10)),
    Math.min(1, Math.max(.1, Math.ceil((Math.max(...curveValues) + .05) * 10) / 10)),
  ] : [-1, 1];

  return <section className="result-card cio-comparison" aria-label="CIO-input model comparison" aria-busy={loading}>
    <div className="result-header cio-comparison-header">
      <h3 className="result-title">CIO-input model comparison</h3>
      <button type="button" className="export-btn" disabled={!data || (!hasRows && !hasCurve)} onClick={() => exportComparison(data)}>Export CSV</button>
    </div>
    <div className="cio-comparison-controls">
      <label>Region
        <select aria-label="Comparison region" value={region} onChange={event => setRegion(event.target.value)}>
          <option value="focus">Focus region · 112–121°E, 23–27°N</option>
          <option value="eastasia">East Asia · 100–125°E, 20–40°N</option>
        </select>
      </label>
      <label>Lead-time curve
        <select aria-label="Comparison curve scope" value={scope} onChange={event => setScope(event.target.value)}>
          <option value="year">Selected year · {year}</option>
          <option value="all">Across years · equal year weight</option>
        </select>
      </label>
    </div>
    {loading && <div className="cio-comparison-state" role="status">Loading paired model results…</div>}
    {current && response.status === 'error' && <div className="cio-comparison-state cio-comparison-error" role="alert">
      <p>{response.error}</p>
      <button type="button" className="export-btn" onClick={() => setRetry(value => value + 1)}>Retry comparison</button>
    </div>}
    {data && <>
      <div className="cio-comparison-curve-heading">
        <span>{scope === 'all' ? `${coverage.yearLabel} · equal-weight year mean` : `${data.year} · lead-time comparison`}</span>
        <span className="cio-comparison-legend">
          {MODELS.map(model => <span key={model} style={{ color: MODEL_STYLES[model].color }}>
            <svg width="28" height="10" viewBox="0 0 28 10" aria-hidden="true">
              <line x1="1" y1="5" x2="27" y2="5" stroke="currentColor"
                strokeWidth={MODEL_STYLES[model].width} strokeLinecap="round" />
            </svg>
            {model}
          </span>)}
        </span>
      </div>
      {hasCurve ? <div className="cio-comparison-chart" role="img" aria-label={`Mean grid-point correlation by lead for LSTM, ASTGRN and STDN, ${scope === 'all' ? coverage.yearLabel : data.year}, ${data.regionLabel || region}`}>
        <ResponsiveContainer width="100%" height={210}>
          <LineChart data={data.curve} margin={{ top: 10, right: 15, bottom: 22, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e1e9ed" />
            <XAxis dataKey="lead" type="number" domain={[1, 20]} ticks={[1, 5, 10, 15, 20]} fontSize={11} tickMargin={6}
              label={{ value: 'Lead time (days)', position: 'insideBottom', offset: -13, fontSize: 11 }} />
            <YAxis domain={curveDomain} tickCount={5} width={48} fontSize={11}
              label={{ value: 'Mean grid r', angle: -90, position: 'insideLeft', offset: 9, fontSize: 11 }} />
            <Tooltip formatter={value => formatMetric(value)} labelFormatter={value => `Lead time: ${value} days`} />
            <ReferenceLine y={0} stroke="#a3b4be" />
            <ReferenceLine x={leadNumber} stroke="#697d88" strokeDasharray="3 3" />
            {MODELS.map(model => <Line key={model} dataKey={model} type="linear" stroke={MODEL_STYLES[model].color}
              strokeWidth={MODEL_STYLES[model].width} strokeLinecap="round"
              dot={false} activeDot={{ r: 4, fill: MODEL_STYLES[model].color, stroke: '#fff', strokeWidth: 1 }}
              connectNulls={false} isAnimationActive={false} />)}
          </LineChart>
        </ResponsiveContainer>
      </div> : <p className="cio-comparison-state">No paired lead-time results are available for this selection.</p>}
      <p className="cio-comparison-coverage">{scope === 'all' ? 'Curve: equal-weight mean of paired years at each lead.' : 'Curve: paired results for the selected year.'}{coverage.text && ` ${coverage.text}.`}</p>
      <div className="cio-comparison-table-heading">Current selection · {data.year} · {data.lead}-day lead
        <span>{Number.isFinite(data.sampleCount) ? `${data.sampleCount} samples` : ''}{Number.isFinite(data.validGridPoints) ? ` · ${data.validGridPoints} common correlation points` : ''}</span>
      </div>
      {hasRows ? <div className="table-wrap">
        <table className="cio-comparison-table">
          <thead><tr><th scope="col">Model</th><th scope="col">Mean grid-point r</th><th scope="col">RMSE<br /><small>mm/day</small></th><th scope="col">MAE<br /><small>mm/day</small></th></tr></thead>
          <tbody>{rows.filter(Boolean).map(row => <tr key={row.model}>
            <th scope="row"><span style={{ color: MODEL_STYLES[row.model].color }}>{row.model}</span></th>
            <td>{formatMetric(row.meanGridR)}</td><td>{formatMetric(row.rmse, 3)}</td><td>{formatMetric(row.mae, 3)}</td>
          </tr>)}</tbody>
        </table>
      </div> : <p className="cio-comparison-state">The selected year and lead do not have paired model results.</p>}
    </>}
  </section>;
}
