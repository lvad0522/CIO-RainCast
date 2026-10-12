// 阶段② 模型输入：把"② 落盘的那一份"直接画出来。模型名随 prop 走后端 DATA_FAMILY
// （App 恒传；缺省回落 'LSTM' = 无 model 字段的旧后端，见 App.jsx 同处注释）。
// 它**自己**去 /api/chain/jobs/{id}/series 取 normalizedWindow（design D12），
// 不复用① 的取数结果 —— 面板上看到的与阶段③ 读盘喂模型的是同一个端点字段。
// 模型名由 App 经 `model` prop 注入（跟随后端 /api/run 的 model 字段）。
import { Fragment, useEffect, useState } from 'react';
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';

const API_BASE = import.meta.env.VITE_API_BASE || '';


function formatValue(value) {
  return Number.isFinite(value) ? value.toFixed(4) : '—';
}

export default function NormalizationPanel({ job, apiBase = API_BASE, model = 'LSTM' }) {
  const [window_, setWindow] = useState(null);
  const [error, setError] = useState(null);
  const normalization = job?.normalization || {};
  const selectedRange = normalization.selectedRange || [];

  useEffect(() => {
    if (!job?.jobId) return undefined;
    let alive = true;
    fetch(`${apiBase}/api/chain/jobs/${job.jobId}/series`)
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.detail || `Unable to load normalized input (${response.status})`);
        }
        return payload;
      })
      .then(payload => { if (alive) setWindow(payload.normalizedWindow || []); })
      .catch((reason) => { if (alive) setError(reason.message || 'Unable to load normalized input'); });
    return () => { alive = false; };
  }, [job?.jobId, apiBase]);

  const chartData = (window_ || []).map((value, index) => ({ index: index + 1, value }));
  const usedLength = normalization.usedLength ?? '—';
  const targetYear = normalization.targetYear ?? job?.projection?.year;
  const flow = [
    {
      label: 'Projected CIO',
      value: `${normalization.inputLength ?? '—'} samples`,
      note: 'Full projected series',
    },
    {
      label: 'Min–max reference',
      value: `${usedLength} samples`,
      note: `Min ${formatValue(normalization.cioMin)} · max ${formatValue(normalization.cioMax)}`,
    },
    {
      label: targetYear ? `Window · ${targetYear}` : 'Target-year window',
      value: selectedRange.length === 2
        ? `Samples ${selectedRange[0] + 1}–${selectedRange[1]}`
        : '112 samples',
      note: 'Normalized window',
    },
    {
      label: `${model} input`,
      value: `${chartData.length || 112} days`,
      note: 'Prepared model input',
    },
  ];

  return (
    <div className="result-card normalization-panel">
      <div className="result-header">
        <div>
          <h3 className="result-title" style={{ margin: 0 }}>Normalized CIO · 112-day {model} input</h3>
          <></>
        </div>
        <span className="region-badge">{normalization.mode || '—'}</span>
      </div>

      <div className="normalization-flow" aria-label={`${model} input preparation`}>
        {flow.map((step, index) => (
          <Fragment key={step.label}>
            <div className="normalization-step">
              <span>{step.label}</span>
              <strong>{step.value}</strong>
              <small>{step.note}</small>
            </div>
            {index < flow.length - 1 && <span className="normalization-arrow" aria-hidden="true">→</span>}
          </Fragment>
        ))}
      </div>
      <></>
      {normalization.warning && <p className="smoke-warning">{normalization.warning}</p>}
      {error && <div className="error-banner">{error}</div>}

      {chartData.length ? (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={chartData} margin={{ top: 14, right: 16, bottom: 22, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="index"
              minTickGap={24}
              fontSize={12}
              height={60}
              tickMargin={8}
              label={{ value: 'Time step', position: 'insideBottom', offset: 18, fontSize: 12 }}
            />
            <YAxis
              width={60}
              fontSize={12}
              domain={[0, 1]}
              label={{ value: 'Normalized CIO', angle: -90, position: 'insideLeft', offset: 16, textAnchor: 'middle', fontSize: 12 }}
            />
            <Tooltip
              labelFormatter={value => `Time step ${value}`}
              formatter={value => [Number(value).toFixed(4), 'Normalized CIO']}
            />
            <Line
              type="linear"
              dataKey="value"
              stroke="#3b8734"
              dot={false}
              strokeWidth={1.5}
              name={`${model} input`}
            />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div className="cio-unavailable" role="status">
          <strong>Loading normalized input</strong>
          <span>Loading saved series</span>
        </div>
      )}
    </div>
  );
}
