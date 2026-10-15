import { useState, useCallback, useEffect, useRef } from 'react';
// Upload workflow disabled by request; preserved for future restoration.
// import AppUpload from './AppUpload';
import ParamPanel from './components/ParamPanel';
import SkillMap from './components/SkillMap';
import TimeSeriesChart from './components/TimeSeriesChart';
import ModelCompareChart from './components/ModelCompareChart';
import DatasetEvaluation from './components/DatasetEvaluation';
import CioModelComparison from './components/CioModelComparison';
import CioProjectionResult from './components/CioProjectionResult';
import NormalizationPanel from './components/NormalizationPanel';
import { staticCaseInfo } from './staticMode';
import './App.css';

const API_BASE = import.meta.env.VITE_DATA_API_BASE || import.meta.env.VITE_API_BASE || '';
const defaults = { predYear: 2000, leadTime: 'pre20', predRegion: 'eastasia' };

async function read(path, signal) {
  const response = await fetch(`${API_BASE}${path}`, { signal });
  const payload = await response.json();
  if (!response.ok) throw new Error(typeof payload.detail === 'string' ? payload.detail : `Unable to load results (${response.status}).`);
  return payload;
}

export default function App() {
  const [params, setParams] = useState(defaults);
  const [running, setRunning] = useState(true);
  const [results, setResults] = useState(null);
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [selectedFold, setSelectedFold] = useState(null);
  const [grid, setGrid] = useState({ i: 40, j: 50 });
  // 静态演示站：当前组合是否带逐日场与格点序列（普通构建恒为 null，不参与判断）。
  const [caseInfo, setCaseInfo] = useState(null);
  const requests = useRef(null);
  const gridRequests = useRef(null);

  const load = useCallback(async selection => {
    requests.current?.abort();
    gridRequests.current?.abort();
    const controller = new AbortController();
    requests.current = controller;
    setRunning(true);
    setError(null);
    setResults(null);
    setJob(null);
    setCaseInfo(null);
    const query = new URLSearchParams({ year: selection.predYear, lead: selection.leadTime });
    const settled = await Promise.allSettled([
      read(`/api/run?${query}&region=eastasia`, controller.signal),
      read(`/api/default-cio?${query}`, controller.signal),
      staticCaseInfo(selection.predYear, selection.leadTime),
    ]);
    if (controller.signal.aborted) return;
    const [rain, cio, info] = settled;
    if (info.status === 'fulfilled') setCaseInfo(info.value);
    if (rain.status === 'fulfilled') {
      setResults({ ...rain.value, year: selection.predYear, lead: selection.leadTime });
      setSelectedFold(rain.value.table?.[0]?.experiment);
      setGrid({ i: 40, j: 50 });
    }
    if (cio.status === 'fulfilled') setJob(cio.value);
    const failures = settled.filter(item => item.status === 'rejected').map(item => item.reason.message);
    if (failures.length) setError(failures.join(' '));
    setRunning(false);
  }, []);

  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => { if (mounted) load(defaults); });
    return () => { mounted = false; requests.current?.abort(); gridRequests.current?.abort(); };
  }, [load]);

  const handleGridClick = useCallback(async (i, j) => {
    if (!results) return;
    gridRequests.current?.abort();
    const controller = new AbortController();
    gridRequests.current = controller;
    setGrid({ i, j });
    try {
      const query = new URLSearchParams({ i, j, region: 'eastasia', year: results.year, lead: results.lead });
      const series = await read(`/api/grid?${query}`, controller.signal);
      if (!controller.signal.aborted) setResults(previous => ({ ...previous, timeSeries: series }));
    } catch (reason) {
      if (reason.name !== 'AbortError') setError(reason.message);
    }
  }, [results]);

  // 模型名跟随后端 /api/run 的 "model" 字段（后端 DATA_FAMILY：默认 ASTGRN，LSTM 站为 LSTM）。
  // 不写死：写死就会把 LSTM 站的数据标成 ASTGRN——正是"旧数值改标签充当 ASTGRN"要防的错。
  // 回落只能是 'LSTM'：没有 model 字段的后端 = 2026-10-12 换树之前起的旧代码，旧代码只有
  // LSTM 树；回落到 'ASTGRN' 才会把旧数据标错名（8001 上现挂的旧后端即此情形）。
  const modelName = results?.model || 'LSTM';
  // 静态演示站：数据集里每个组合都带逐日场/格点序列；只有烘焙时没写完整层的
  // 数据集才会把 caseInfo.full 置为 false。普通构建 caseInfo 为 null → 全放开。
  const dailyAvailable = !caseInfo || caseInfo.full;

  return <div className="app" lang="en">
    <aside className="sidebar">
      <div className="logo">
        <h1>CIO-RainCast</h1>
        <p>East Asian Summer Monsoon Intraseasonal Rainfall Prediction</p>
      </div>
      <div className="panel-section">
        <h3 className="section-title">Data source</h3>
        <span className="default-source">System CIO dataset <i>✓</i></span>
      </div>
      <ParamPanel params={params} onChange={(key, value) => setParams(previous => ({ ...previous, [key]: value }))} disabled={running} />
      <div className="panel-section">
        <button className="run-btn" onClick={() => load(params)} disabled={running}>
          {running ? 'Loading results…' : 'Explore results'}
        </button>
      </div>
      <nav className="section-nav" aria-label="Results sections">
        <a href="#cio-projection">01 / CIO & U850</a>
        <a href="#model-input">02 / Model input</a>
        <a href="#rainfall">03 / Rainfall prediction</a>
      </nav>
      <div className="sidebar-footer">
        <p>Based on Zhou et al. (2024), GRL</p>
        <button className="intro-replay" onClick={() => window.dispatchEvent(new Event('cio-rain:replay-intro'))}>Replay intro</button>
      </div>
    </aside>
    <main className="main-content" aria-busy={running}>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setError(null)} className="error-close" aria-label="Dismiss error">×</button></div>}
      {running && <div className="empty-state" role="status"><h2>Loading your forecast</h2><p>Opening locally prepared results…</p></div>}
      {job && <>
        <section id="cio-projection" className="chain-stage-group">
          <h2 className="chain-stage-heading">01 / CIO & Indian Ocean U850</h2>
          <CioProjectionResult key={job.jobId} job={job} apiBase={API_BASE} />
        </section>
        <section id="model-input" className="chain-stage-group">
          <h2 className="chain-stage-heading">02 / {modelName} input</h2>
          <NormalizationPanel key={job.jobId} job={job} apiBase={API_BASE} model={modelName} />
        </section>
      </>}
      {results && <section id="rainfall" className="chain-stage-group">
        <h2 className="chain-stage-heading">03 / East Asian rainfall · {results.year} · {String(results.lead).replace('pre', '')}-day lead</h2>
        <div className="result-row overview-row">
          <div className="result-col"><SkillMap key={`${results.year}-${results.lead}`} data={results.skillMap} region="eastasia" onGridClick={dailyAvailable ? handleGridClick : undefined} /></div>
          <div className="result-col">
            <ModelCompareChart data={results.s2s} />
          </div>
        </div>
        <CioModelComparison />
        <TimeSeriesChart data={results.timeSeries} gridLabel={`${(100 + grid.j * .25).toFixed(2)}°E, ${(20 + grid.i * .25).toFixed(2)}°N`} />
        {!dailyAvailable && <p className="static-demo-note" role="status">
          Day-by-day fields and grid-point time series are missing from this static demo dataset, so clicking the skill map is disabled here.
        </p>}
        {dailyAvailable
          ? <DatasetEvaluation key={`${results.year}-${results.lead}-${selectedFold}`} year={results.year} lead={results.lead} fold={selectedFold} />
          : <p className="static-demo-note" role="status">
            The evaluation panel (daily prediction / observation / error fields and downloads) is missing from this static demo dataset.
          </p>}
      </section>}
    </main>
  </div>;
}
