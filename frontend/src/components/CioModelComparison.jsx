import { useMemo, useState } from 'react';
import {
  CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import comparisonData from '../data/annualModelComparison.json';
import {
  METHODS, aggregateAnnualComparison, buildAnnualComparisonCsv, getConfigurationLabel,
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

function exportComparison(start, end) {
  const csv = buildAnnualComparisonCsv(comparisonData, start, end);
  const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `annual_model_comparison_2000-2019_pre${start}${start === end ? '' : `-pre${end}`}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function CioModelComparison() {
  const [mode, setMode] = useState('range');
  const [singlePre, setSinglePre] = useState(7);
  const [range, setRange] = useState({ start: 1, end: 7 });
  const [hidden, setHidden] = useState([]);
  const start = mode === 'single' ? singlePre : range.start;
  const end = mode === 'single' ? singlePre : range.end;
  const regions = useMemo(() => aggregateAnnualComparison(comparisonData, start, end), [start, end]);
  const label = getConfigurationLabel(start, end);
  const toggle = method => setHidden(current => current.includes(method)
    ? current.filter(item => item !== method) : [...current, method]);

  return <section className="result-card cio-comparison annual-comparison" aria-label="Model comparison across years">
    <div className="result-header cio-comparison-header">
      <h3 className="result-title">Model comparison across years</h3>
      <button type="button" className="export-btn" onClick={() => exportComparison(start, end)}>Export CSV</button>
    </div>
    <div className="annual-comparison-controls">
      <label>View
        <select aria-label="Comparison configuration mode" value={mode} onChange={event => setMode(event.target.value)}>
          <option value="range">Configuration average</option>
          <option value="single">Single configuration</option>
        </select>
      </label>
      {mode === 'range' ? <>
        <label>From
          <select aria-label="First comparison configuration" value={range.start} onChange={event => {
            const value = Number(event.target.value);
            setRange(current => ({ start: value, end: Math.max(value, current.end) }));
          }}>
            {comparisonData.configurations.map(pre => <option key={pre} value={pre}>pre{pre}</option>)}
          </select>
        </label>
        <label>To
          <select aria-label="Last comparison configuration" value={range.end} onChange={event => {
            const value = Number(event.target.value);
            setRange(current => ({ start: Math.min(value, current.start), end: value }));
          }}>
            {comparisonData.configurations.map(pre => <option key={pre} value={pre}>pre{pre}</option>)}
          </select>
        </label>
      </> : <div className="annual-comparison-slider">
        <label htmlFor="annual-comparison-pre">Input configuration <output htmlFor="annual-comparison-pre">pre{singlePre}</output></label>
        <input id="annual-comparison-pre" type="range" min="1" max="20" step="1" value={singlePre}
          aria-label="Comparison input configuration" onChange={event => setSinglePre(Number(event.target.value))} />
        <div className="annual-comparison-endpoints"><span>pre1</span><span>pre20</span></div>
      </div>}
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
    {regions.map((region, index) => <div className="annual-comparison-panel" key={region.id}>
      <h4>({index === 0 ? 'a' : 'b'}) {region.label}</h4>
      <div className="cio-comparison-chart" role="img"
        aria-label={`Annual mean grid-point Pearson r, ${region.label}, ${label}, 2000–2019`}>
        <ResponsiveContainer width="100%" height={210}>
          <LineChart data={region.points} syncId="annual-model-comparison" syncMethod="value"
            margin={{ top: 10, right: 20, bottom: index === 1 ? 23 : 5, left: 0 }}>
            <CartesianGrid vertical={false} stroke="#e1e9ed" />
            <XAxis dataKey="year" type="number" domain={[1999.6, 2019.4]} ticks={[2000, 2005, 2010, 2015, 2019]}
              allowDecimals={false} fontSize={11} tickMargin={7}
              label={index === 1 ? { value: 'Evaluation year', position: 'insideBottom', offset: -14, fontSize: 11 } : undefined} />
            <YAxis domain={AXES[region.id].domain} ticks={AXES[region.id].ticks} width={78} fontSize={11} tickMargin={8}
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
    </div>)}
    <p className="annual-comparison-note">Other-year mean: same-position observations from the other 19 years.</p>
    <p className="annual-comparison-coverage">{comparisonData.years.length * (end - start + 1)} cases per region · Common valid correlation points</p>
  </section>;
}
