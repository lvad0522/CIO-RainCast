import { useEffect, useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { REGIONAL_MODELS, REGIONAL_SERIES, buildRegionalSeriesCsv, loadRegionalSeries } from '../utils/regionalSeries';

const STYLES = {
  observation: { color: '#263c48', label: 'Observation' },
  LSTM: { color: '#D17B27', label: 'LSTM' },
  ASTGRN: { color: '#2463A0', label: 'ASTGRN' },
  STDN: { color: '#438565', label: 'STDN' },
};
const format = (value, digits) => Number.isFinite(value) ? value.toFixed(digits) : '—';

function exportSeries(data) {
  const url = URL.createObjectURL(new Blob(['\uFEFF', buildRegionalSeriesCsv(data)], { type: 'text/csv;charset=utf-8;' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `regional_model_series_${data.year}_pre${data.lead}_${data.region.id}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function RegionalModelComparison({ year, lead, selectedRegion = 'focus', onRegionChange, apiBase = '' }) {
  const leadNumber = Number(String(lead).replace(/^pre/, ''));
  const requestKey = `${apiBase}|${year}|${leadNumber}|${selectedRegion}`;
  const [response, setResponse] = useState(null);
  const [hidden, setHidden] = useState([]);
  const current = response?.key === requestKey ? response : null;
  const data = current?.data;

  useEffect(() => {
    const controller = new AbortController();
    loadRegionalSeries({ year, lead: leadNumber, region: selectedRegion }, {
      apiBase, signal: controller.signal, bakedBase: `${import.meta.env.BASE_URL}demo-data/`,
    }).then(payload => {
      if (!controller.signal.aborted) setResponse({ key: requestKey, data: payload });
    }).catch(reason => {
      if (!controller.signal.aborted) setResponse({ key: requestKey, error: reason.message });
    });
    return () => controller.abort();
  }, [apiBase, year, leadNumber, selectedRegion, requestKey]);

  const toggle = method => setHidden(previous => previous.includes(method)
    ? previous.filter(value => value !== method) : [...previous, method]);

  return <section id="regional-model-comparison" className="result-card cio-comparison regional-model-comparison"
    aria-label="Regional model time-series comparison" aria-busy={!current}>
    <div className="result-header cio-comparison-header">
      <h3 className="result-title">Regional time series · {year}/pre{leadNumber}</h3>
      <button type="button" className="export-btn" disabled={!data} onClick={() => exportSeries(data)}>Export CSV</button>
    </div>
    <div className="annual-comparison-controls"><label>Region
      <select aria-label="Regional time-series region" value={selectedRegion} onChange={event => onRegionChange?.(event.target.value)}>
        <option value="focus">Focus region · 112–121°E, 23–27°N</option>
        <option value="eastasia">East Asia · 100–125°E, 20–40°N</option>
      </select>
    </label></div>
    {!current && <p className="current-model-metrics-status" role="status">Loading regional curves…</p>}
    {current?.error && <p className="current-model-metrics-status" role="status">{current.error}</p>}
    {data && <>
      <div className="annual-comparison-summary">
        <span>{data.retainedSamples} retained samples · Input-window configuration pre{leadNumber}</span>
        <div className="annual-comparison-legend" aria-label="Regional time-series curves">
          {REGIONAL_SERIES.map(method => <button key={method} type="button" onClick={() => toggle(method)}
            aria-pressed={!hidden.includes(method)} className={hidden.includes(method) ? 'is-hidden' : ''}
            style={{ color: STYLES[method].color }}>
            <svg width="25" height="10" aria-hidden="true"><line x1="0" y1="5" x2="25" y2="5" stroke="currentColor" strokeWidth="2" /></svg>
            {STYLES[method].label}
          </button>)}
        </div>
      </div>
      <div className="cio-comparison-chart" role="img" aria-label={`Observed and three-model regional-mean rainfall, ${data.region.label}, ${year}, pre${leadNumber}`}>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={data.samples} margin={{ top: 12, right: 20, bottom: 20, left: 12 }}>
            <CartesianGrid vertical={false} stroke="#e1e9ed" />
            <XAxis dataKey="index" type="number" domain={[1, 112]} ticks={[1, 29, 57, 85, 112]} fontSize={11}
              tickFormatter={value => data.samples[value - 1]?.date.slice(5) ?? value}
              label={{ value: 'Target date (month–day)', position: 'insideBottom', offset: -13, fontSize: 11 }} />
            <YAxis domain={['auto', 'auto']} width={65} fontSize={11}
              label={{ value: 'Anomaly (mm/day)', angle: -90, position: 'insideLeft', offset: 5, fontSize: 11, textAnchor: 'middle' }} />
            <Tooltip formatter={value => format(value, 3)}
              labelFormatter={index => data.samples[Number(index) - 1]?.date ?? `Sample ${index}`} />
            <ReferenceLine y={0} stroke="#929da4" />
            {REGIONAL_SERIES.map(method => <Line key={method} dataKey={method} name={STYLES[method].label}
              hide={hidden.includes(method)} type="linear" stroke={STYLES[method].color}
              strokeWidth={method === 'observation' || method === 'ASTGRN' ? 2.3 : 1.8}
              dot={false} connectNulls={false} isAnimationActive={false} />)}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="current-model-metrics" aria-label="Regional-mean curve metrics">
        <h4 className="current-model-metrics-heading">Regional-mean curve metrics</h4>
        <div className="current-model-metrics-table-wrap"><table className="current-model-metrics-table">
          <thead><tr><th scope="col">Model</th><th scope="col">Temporal r</th><th scope="col">RMSE<small>mm/day</small></th><th scope="col">MAE<small>mm/day</small></th></tr></thead>
          <tbody>{REGIONAL_MODELS.map(model => {
            const row = data.metrics.find(item => item.model === model);
            return <tr key={model}><th scope="row" style={{ color: STYLES[model].color }}>{model}</th>
              <td>{format(row.r, 4)}</td><td>{format(row.rmse, 3)}</td><td>{format(row.mae, 3)}</td></tr>;
          })}</tbody>
        </table></div>
      </div>
    </>}
  </section>;
}
