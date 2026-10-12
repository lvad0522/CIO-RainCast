import { useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid,
  ReferenceLine, ResponsiveContainer,
  BarChart, Bar, Cell,
} from 'recharts';

// 导师 lead_corr_2003 配色（11 个 S2S 模式 + S2S Mean）；本站模型曲线单给一个颜色
const MODEL_COLORS = {
  BOM: '#808080', CMA: '#1a478a', CNRM: '#dc143c', ECCC: '#ffa500',
  ECMWF: '#000000', HMCR: '#800080', ISAC: '#1a478a', JMA: '#dc143c',
  KMA: '#008000', NCEP: '#32cd32', UKMO: '#ffd700',
  S2S_Mean: '#008000',
};
const MODEL_COLOR = '#1a478a';
const MODEL_ORDER = [
  'BOM', 'CMA', 'CNRM', 'ECCC', 'ECMWF',
  'HMCR', 'ISAC', 'JMA', 'KMA', 'NCEP', 'UKMO',
];
// dash-dot（对应导师脚本的 '-.' 虚线）
const DASH_DOT = '5 3 1 3';

export default function ModelCompareChart({ data }) {
  const [hidden, setHidden] = useState([]);
  const toggle = name => setHidden(current => current.includes(name) ? current.filter(item => item !== name) : [...current, name]);
  const isLineData = data && data.length > 0 && 'lead' in data[0];

  // ── 真实数据（折线图）：{lead, 11模式, S2S_Mean, <模型名>} × 20 ──
  if (isLineData) {
    // 本站模型曲线的键名由数据决定（后端 DATA_FAMILY：默认 ASTGRN，LSTM 站为 LSTM），
    // 不写死——写死会把 LSTM 站的曲线标成 ASTGRN，正是"旧数值改标签"防的那类错。
    // 回落 'LSTM'：探不出键名的载荷只可能是换树前的旧后端产物（见 App.jsx）。
    const modelKey = Object.keys(data[0]).find(
      key => key !== 'lead' && key !== 'source' && key !== 'S2S_Mean' && !MODEL_ORDER.includes(key),
    ) || 'LSTM';
    // 图例顺序：导师画线顺序 + S2S Mean + 模型曲线（4 列网格排布）
    const legendOrder = [...MODEL_ORDER, 'S2S_Mean', modelKey];
    const colorOf = name => (name === modelKey ? MODEL_COLOR : MODEL_COLORS[name]);
    return (
      <div className="result-card">
        <h3 className="result-title">{modelKey} vs S2S · 2003 · 1–20-day lead</h3>
        <div style={{ position: 'relative' }}>
          {/* 图例：右上角 4 列网格，半透明白底避免遮挡曲线 */}
          <div style={{
            position: 'absolute', top: 4, right: 4, zIndex: 10,
            display: 'grid', gridTemplateColumns: 'repeat(4, auto)',
            columnGap: 10, rowGap: 2,
            background: 'rgba(255,255,255,0.88)',
            border: '1px solid #e0e0e0', borderRadius: 4,
            padding: '4px 8px', fontSize: 11,
            pointerEvents: 'auto',
          }}>
            {legendOrder.map((name) => (
              <button type="button" key={name} className="chart-legend-button" onClick={() => toggle(name)} aria-pressed={!hidden.includes(name)} style={{ display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap', opacity: hidden.includes(name) ? .35 : 1 }}>
                <span style={{
                  display: 'inline-block', width: 16, height: 2,
                  background: name === 'S2S_Mean' || name === modelKey
                    ? colorOf(name)
                    : `repeating-linear-gradient(90deg, ${MODEL_COLORS[name]} 0 2px, transparent 2px 4px)`,
                }} />
                {name}
              </button>
            ))}
          </div>
          <ResponsiveContainer width="100%" height={340}>
            <LineChart data={data} margin={{ top: 14, right: 16, bottom: 14, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
              <XAxis dataKey="lead" type="number" domain={[1, 20]}
                     tickCount={20} fontSize={11} height={50} tickMargin={8} label={{ value: 'Lead time', position: 'insideBottom', offset: 12, fontSize: 12 }} />
              <YAxis domain={[-0.4, 1]} fontSize={11} ticks={[-0.3, 0, 0.3, 0.5, 0.7, 1.0]}
                     label={{ value: 'Correlation', angle: -90, position: 'insideLeft', offset: 16, textAnchor: 'middle', fontSize: 12 }} />
              <Tooltip
                formatter={(v) => (v == null ? '—' : Number(v).toFixed(3))}
                labelFormatter={(label) => `Lead time: ${label} days`}
                position={{ y: 80 }}
                offset={{ x: 0, y: 0 }}
                allowEscapeViewBox={{ x: false, y: true }}
              />
              <ReferenceLine y={0} stroke="#808080" strokeDasharray="4 4" />
              <ReferenceLine y={0.5} stroke="#808080" strokeDasharray="4 4" />
            {MODEL_ORDER.map((name) => (
              <Line hide={hidden.includes(name)} key={name} type="monotone" dataKey={name}
                    stroke={MODEL_COLORS[name]} strokeWidth={1.2}
                    strokeDasharray={DASH_DOT} dot={false}
                    connectNulls={false} />
            ))}
            <Line type="monotone" dataKey="S2S_Mean" hide={hidden.includes('S2S_Mean')} stroke="#008000"
                  strokeWidth={3} dot={false} />
            <Line type="monotone" dataKey={modelKey} hide={hidden.includes(modelKey)} stroke={MODEL_COLOR}
                  strokeWidth={4} dot={false} connectNulls={false} />
          </LineChart>
        </ResponsiveContainer>
        </div>
        <></>
      </div>
    );
  }

  // ── 降级数据（柱状图回退）：{name, r} × 12 ──
  const mockModel = (data || []).find(d => d.name && d.name.endsWith('+CIO'))?.name || 'ASTGRN+CIO';
  return (
    <div className="result-card">
      <h3 className="result-title">{mockModel} vs S2S</h3>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={data} margin={{ top: 14, right: 16, bottom: 50, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="name" angle={-35} textAnchor="end" fontSize={11} interval={0} />
          <YAxis domain={[0, 0.8]} label={{ value: 'Pearson r', angle: -90, position: 'insideLeft', offset: 16, textAnchor: 'middle', fontSize: 12 }} />
          <Tooltip formatter={(v) => v.toFixed(3)} />
          <Bar dataKey="r" radius={[4, 4, 0, 0]} activeBar={false}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.name === mockModel ? '#e63946' : '#1a478a'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <></>
    </div>
  );
}
