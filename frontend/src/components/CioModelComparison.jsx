import { useMemo, useState } from 'react';
import {
  CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import comparisonData from '../data/annualModelComparison.json';
import CurrentModelMetrics from './CurrentModelMetrics';
import {
  METHODS, aggregateAnnualComparison, buildAnnualComparisonCsv,
} from '../utils/annualComparison';

const STYLES = {
  LSTM: { color: '#D17B27', marker: 'square', label: 'LSTM' },
  ASTGRN: { color: '#2463A0', marker: 'circle', label: 'ASTGRN' },
  STDN: { color: '#438565', marker: 'triangle', label: 'STDN' },
  reference: { color: '#636363', marker: 'diamond', label: 'Other-year mean', dash: '6 4' },
};

// Keep each region's scale fixed while changing configurations or hiding a series.
const AXES = Object.fromEntries(comparisonData.regions.map(region => {
  const values = region.points.flatMap(point => METHODS.map(method => point[method]));
  const step = region.id === 'eastasia' ? .1 : .2;
  const lower = Math.max(-1, Math.floor((Math.min(...values) - .01) / step) * step);
  const upper = Math.min(1, Math.ceil((Math.max(...values) + .01) / step) * step);
  const ticks = Array.from({ length: Math.round((upper - lower) / step) + 1 },
    (_, index) => Number((lower + index * step).toFixed(2)));
  return [region.id, { domain: [lower, upper], ticks }];
}));

function Marker({ cx, cy, method, size = 2.8 }) {
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  const { color, marker } = STYLES[method];
  const common = { fill: color, stroke: color, strokeWidth: 1 };
  if (marker === 'square') return <rect x={cx - size} y={cy - size} width={size * 2} height={size * 2} {...common} />;
  if (marker === 'triangle') return <path d={`M ${cx} ${cy - size - 1} L ${cx + size + 1} ${cy + size} L ${cx - size - 1} ${cy + size} Z`} {...common} />;
  if (marker === 'diamond') return <path d={`M ${cx} ${cy - size - 1} L ${cx + size + 1} ${cy} L ${cx} ${cy + size + 1} L ${cx - size - 1} ${cy} Z`} {...common} fill="#fff" />;
  return <circle cx={cx} cy={cy} r={size} {...common} />;
}

function exportComparison(end, region) {
  const csv = buildAnnualComparisonCsv(comparisonData, 1, end, region);
  const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `annual_model_comparison_${region}_2000-2019_pre1${end === 1 ? '' : `-pre${end}`}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function CioModelComparison({ year, lead, apiBase = '' }) {
  const [selectedRegion, setSelectedRegion] = useState('focus');
  const [end, setEnd] = useState(7);
  const [hidden, setHidden] = useState([]);
  const regions = useMemo(() => aggregateAnnualComparison(comparisonData, 1, end), [end]);
  const region = regions.find(item => item.id === selectedRegion);
  const label = end === 1 ? '1-day lead' : `1–${end}-day mean`;
  const toggle = method => setHidden(current => current.includes(method)
    ? current.filter(item => item !== method) : [...current, method]);

  return <section className="result-card cio-comparison annual-comparison" aria-label="Model comparison across years">
    <div className="result-header cio-comparison-header">
      <h3 className="result-title">Model comparison across years</h3>
      <button type="button" className="export-btn" onClick={() => exportComparison(end, selectedRegion)}>Export CSV</button>
    </div>
    <div className="annual-comparison-controls">
      <label>Region
        <select aria-label="Comparison region" value={selectedRegion} onChange={event => setSelectedRegion(event.target.value)}>
          <option value="focus">Focus region</option>
          <option value="eastasia">East Asia</option>
        </select>
      </label>
      <label>Lead-time average
        <select aria-label="Comparison lead-time window" value={end} onChange={event => setEnd(Number(event.target.value))}>
          {comparisonData.configurations.map(pre => <option key={pre} value={pre}>{pre === 1 ? '1 day' : `1–${pre} days`}</option>)}
        </select>
      </label>
    </div>
    <div className="annual-comparison-summary">
      <span aria-live="polite">{label} · 2000–2019</span>
      <div className="annual-comparison-legend" aria-label="Annual comparison series">
        {METHODS.map(method => <button type="button" key={method} aria-pressed={!hidden.includes(method)}
          aria-label={`${STYLES[method].label} series`} onClick={() => toggle(method)}
          className={hidden.includes(method) ? 'is-hidden' : ''} style={{ color: STYLES[method].color }}
          title={method === 'reference' ? comparisonData.referenceDefinition : `Toggle ${STYLES[method].label}`}>
          <svg width="28" height="12" viewBox="0 0 28 12" aria-hidden="true">
            <line x1="1" y1="6" x2="27" y2="6" stroke="currentColor" strokeWidth="2" strokeDasharray={STYLES[method].dash} />
            <Marker cx={14} cy={6} method={method} size={2.3} />
          </svg>
          {STYLES[method].label}
        </button>)}
      </div>
    </div>
    <div className="annual-comparison-panel">
      <h4>{region.label}</h4>
      <div className="cio-comparison-chart" role="img"
        aria-label={`Annual mean grid-point Pearson r, ${region.label}, ${label}, 2000–2019`}>
        <ResponsiveContainer width="100%" height={245}>
          <LineChart data={region.points}
            margin={{ top: 10, right: 10, bottom: 23, left: 0 }}>
            <CartesianGrid vertical={false} stroke="#e1e9ed" />
            <XAxis dataKey="year" type="number" domain={[1999.6, 2019.4]} ticks={[2000, 2005, 2010, 2015, 2019]}
              allowDecimals={false} fontSize={11} tickMargin={7}
              label={{ value: 'Evaluation year', position: 'insideBottom', offset: -14, fontSize: 11 }} />
            <YAxis domain={AXES[region.id].domain} ticks={AXES[region.id].ticks} width={64} fontSize={11} tickMargin={8}
              tickFormatter={value => Number(value.toFixed(2))}
              label={{ value: 'Mean grid-point r', angle: -90, position: 'insideLeft', offset: 9, fontSize: 11, textAnchor: 'middle' }} />
            <Tooltip formatter={value => Number.isFinite(value) ? value.toFixed(4) : '—'}
              labelFormatter={year => `Evaluation year: ${year}`}
              cursor={{ stroke: '#9cb7c3', strokeDasharray: '3 3' }} />
            <ReferenceLine y={0} stroke="#929da4" />
            {METHODS.map(method => <Line key={method} dataKey={method} name={STYLES[method].label} type="linear"
              hide={hidden.includes(method)} stroke={STYLES[method].color} strokeWidth={method === 'ASTGRN' ? 2.5 : 2}
              strokeDasharray={STYLES[method].dash} strokeLinecap="round"
              dot={<Marker method={method} />} activeDot={<Marker method={method} size={4} />}
              connectNulls={false} isAnimationActive={false} />)}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
    <p className="annual-comparison-note">Other-year mean: same-position observations from the other 19 years.</p>
    <p className="annual-comparison-coverage">{comparisonData.years.length * end} cases · Common valid correlation points</p>
    <CurrentModelMetrics year={year} lead={lead} region={selectedRegion} apiBase={apiBase} />
  </section>;
}
