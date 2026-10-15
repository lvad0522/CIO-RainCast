import { useEffect, useState } from 'react';

const MODELS = ['LSTM', 'ASTGRN', 'STDN'];
const COLORS = { LSTM: '#D17B27', ASTGRN: '#2463A0', STDN: '#438565' };
const format = (value, digits) => Number.isFinite(value) ? value.toFixed(digits) : '—';

export default function CurrentModelMetrics({ year, lead, region, apiBase = '' }) {
  const leadNumber = Number(String(lead).replace(/^pre/, ''));
  const requestKey = `${apiBase}|${year}|${leadNumber}|${region}`;
  const [response, setResponse] = useState(null);
  const current = response?.key === requestKey ? response : null;

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ year, lead: leadNumber, region, scope: 'year' });
    async function load() {
      try {
        const result = await fetch(`${apiBase}/api/model-comparison?${query}`, { signal: controller.signal });
        const payload = await result.json();
        if (!result.ok) throw new Error(typeof payload.detail === 'string' ? payload.detail : `Request failed (${result.status}).`);
        if (payload.year !== Number(year) || payload.lead !== leadNumber || payload.region !== region
          || payload.source !== 'dataset' || !Array.isArray(payload.rows)
          || !Number.isInteger(payload.sampleCount) || !Number.isInteger(payload.validGridPoints)
          || payload.rows.length !== MODELS.length || MODELS.some(model => {
            const rows = payload.rows.filter(row => row.model === model);
            return rows.length !== 1 || ['meanGridR', 'rmse', 'mae'].some(metric =>
              rows[0][metric] !== null && !Number.isFinite(rows[0][metric]));
          })) {
          throw new Error('Comparison response does not match the selected case.');
        }
        if (!controller.signal.aborted) setResponse({ key: requestKey, data: payload });
      } catch (reason) {
        if (!controller.signal.aborted) setResponse({ key: requestKey, error: reason.message });
      }
    }
    load();
    return () => controller.abort();
  }, [apiBase, year, leadNumber, region, requestKey]);

  return <section className="current-model-metrics" aria-label="Current selection model metrics" aria-busy={!current}>
    <h4 className="current-model-metrics-heading">Current selection · {year} · {leadNumber}-day lead</h4>
    {!current && <p className="current-model-metrics-status" role="status">Loading comparison metrics…</p>}
    {current?.error && <p className="current-model-metrics-status" role="status">Comparison metrics unavailable. {current.error}</p>}
    {current?.data && <>
      <p className="current-model-metrics-summary">{current.data.sampleCount} samples · {current.data.validGridPoints} common correlation points</p>
      <div className="current-model-metrics-table-wrap">
        <table className="current-model-metrics-table">
          <thead><tr>
            <th scope="col">Model</th>
            <th scope="col">Mean grid-point r</th>
            <th scope="col">RMSE<small>mm/day</small></th>
            <th scope="col">MAE<small>mm/day</small></th>
          </tr></thead>
          <tbody>{MODELS.map(model => {
            const row = current.data.rows.find(item => item.model === model);
            return <tr key={model}>
              <th scope="row" style={{ color: COLORS[model] }}>{model}</th>
              <td>{format(row.meanGridR, 4)}</td>
              <td>{format(row.rmse, 3)}</td>
              <td>{format(row.mae, 3)}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>
    </>}
  </section>;
}
