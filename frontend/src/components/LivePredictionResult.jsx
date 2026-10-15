import { Fragment, useEffect, useRef, useState } from 'react';
import {
  Brush, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { getHeatColor } from '../utils/heatColor';
import { rainfallScaleMax } from '../utils/rainfallScale';
import { rainfallGridPoint } from '../utils/rainfallPoint';
import GridPointTooltip from './GridPointTooltip';
import { isStaticMode, staticAssetUrl } from '../staticMode';

const API_BASE = import.meta.env.VITE_API_BASE || '';
const CELL_SCALE = 6;
const GEO_URL = `${import.meta.env.BASE_URL}geo/east_asia_coastline.json?v=1`;
const MAP_ROWS = 81;
const MAP_COLS = 101;
const CONTOUR_LEVEL = 0.5;
// 所有任务、所有日期共用此误差色标；超出Range的数值仅在颜色上饱和。
const ERROR_COLOR_LIMIT = 50;

const KIND_LABELS = { u850: 'U850 anomalies', sst: 'SST', both: 'SST + U850' };
const KIND_SOURCE_LABELS = { 'explicit-param': 'Selected in interface', filename: 'Detected from filename' };
const NORM_LABELS = {
  'training-equivalent': 'Training-equivalent min–max (first 2240 samples)',
  'extended-base': 'Extended normalization baseline',
  partial: 'Short-series min–max normalization',
};

// 旧版 Pearson 蓝-白-红色标保留作对照，当前不启用：
// function rColor(value) {
//   const t = Math.max(-1, Math.min(1, value));
//   const fade = Math.round(255 * (1 - Math.abs(t)));
//   return t >= 0 ? `rgb(255, ${fade}, ${fade})` : `rgb(${fade}, ${fade}, 255)`;
// }

const VIEW_LABELS = {
  prediction: 'Prediction',
  truth: 'Observation',
  error: 'Error',
};

function contourPathD(grid, threshold) {
  if (!Array.isArray(grid) || !grid.length || !Array.isArray(grid[0])) return '';
  const rows = grid.length;
  const cols = grid[0].length;
  const segments = [];

  const crossing = (a, b) => {
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return null;
    const t = (threshold - a) / (b - a);
    return t > 0 && t < 1 ? t : null;
  };

  for (let i = 0; i < rows - 1; i += 1) {
    for (let j = 0; j < cols - 1; j += 1) {
      const v00 = grid[i][j];
      const v10 = grid[i][j + 1];
      const v11 = grid[i + 1][j + 1];
      const v01 = grid[i + 1][j];
      const top = crossing(v00, v10);
      const right = crossing(v10, v11);
      const bottom = crossing(v01, v11);
      const left = crossing(v00, v01);
      const points = [];
      const yTop = rows - i - 0.5;
      const yBottom = rows - i - 1.5;

      if (top !== null) points.push(['t', j + 0.5 + top, yTop]);
      if (right !== null) points.push(['r', j + 1.5, yTop - right]);
      if (bottom !== null) points.push(['b', j + 0.5 + bottom, yBottom]);
      if (left !== null) points.push(['l', j + 0.5, yTop - left]);

      if (points.length === 2) {
        segments.push([points[0], points[1]]);
      } else if (points.length === 4) {
        const diagonal = v00 >= threshold && v11 >= threshold;
        if (diagonal) {
          segments.push([points[0], points[3]], [points[1], points[2]]);
        } else {
          segments.push([points[0], points[1]], [points[2], points[3]]);
        }
      }
    }
  }

  return segments
    .map(([a, b]) => `M${a[1].toFixed(2)} ${a[2].toFixed(2)}L${b[1].toFixed(2)} ${b[2].toFixed(2)}`)
    .join('');
}

function lonToX(lon, cols) {
  return ((lon - 100) / 25) * cols;
}

function latToY(lat, rows) {
  return rows - ((lat - 20) / 20) * rows;
}

function geoPathD(segments, cols, rows) {
  if (!Array.isArray(segments)) return '';
  return segments
    .filter(Array.isArray)
    .map(segment => segment
      .filter(point => Array.isArray(point) && point.length >= 2)
      .map(([lon, lat], index) => (
        `${index === 0 ? 'M' : 'L'}${lonToX(lon, cols).toFixed(2)} ${latToY(lat, rows).toFixed(2)}`
      ))
      .join(''))
    .join('');
}

function focusBox(rows, cols) {
  const x = lonToX(112, cols);
  const right = lonToX(121, cols);
  const y = latToY(27, rows);
  const bottom = latToY(23, rows);
  return { x, y, width: right - x, height: bottom - y };
}

function GeoHeatmapFrame({ children, data, rows, cols, geoData, selectedPoint = null, contourLabel = '0.5 mm/day contour', showContour = true }) {
  const box = focusBox(rows, cols);
  return (
    <div className="prediction-map-shell">
      <div className="map-body">
        <div className="lat-axis" aria-hidden="true">
          {[40, 35, 30, 25, 20].map(lat => (
            <span
              key={lat}
              className={lat === 20 ? 'bottom' : ''}
              style={lat === 20 ? undefined : { top: `${((40 - lat) / 20) * 100}%` }}
            >{lat}°N</span>
          ))}
          <span className="lat-title">Latitude (°N)</span>
        </div>
        <div className="prediction-canvas-wrap prediction-map-surface">
          {children}
          <svg
            className="heatmap-overlay"
            viewBox={`0 0 ${cols} ${rows}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {geoData && (
              <path
                d={geoPathD(geoData.coast || [], cols, rows)}
                fill="none"
                stroke="#222"
                strokeWidth={1.2}
                opacity={0.9}
                vectorEffect="non-scaling-stroke"
              />
            )}
            {showContour && (
            <path
              d={contourPathD(data, CONTOUR_LEVEL)}
              fill="none"
              stroke="#000"
              strokeWidth={1.6}
              opacity={0.95}
              vectorEffect="non-scaling-stroke"
            />
            )}
            <rect
              x={box.x}
              y={box.y}
              width={box.width}
              height={box.height}
              fill="none"
              stroke="#0057b8"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
            {selectedPoint && (
              <rect
                x={selectedPoint.j}
                y={rows - 1 - selectedPoint.i}
                width={1}
                height={1}
                fill="none"
                stroke="#111"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
        </div>
      </div>
      <div className="lon-axis" aria-hidden="true">
        {[100, 105, 110, 115, 120, 125].map(lon => (
          <span key={lon} style={{ left: `${((lon - 100) / 25) * 100}%` }}>{lon}°E</span>
        ))}
        <span className="lon-title">Longitude (°E)</span>
      </div>
      <div className="geo-overlay-key">
        {showContour && <><span className="geo-key-line geo-key-contour" />{contourLabel}</>}
        <span className="geo-key-line geo-key-focus" />Focus region (112–121°E, 23–27°N)
      </div>
    </div>
  );
}

export default function LivePredictionResult({ job, apiRoot, showSkill = true, showRunSummary = true, initialColorScale = 'shared', showColorScaleControl = false, children }) {
  const [timeIndex, setTimeIndex] = useState(0);
  const [loadedFrame, setFrame] = useState(null);
  const [preferredView, setView] = useState('prediction');
  const [colorScale] = useState(initialColorScale);
  const [pearson, setPearson] = useState(null);
  const [focusRegion, setFocusRegion] = useState(null);
  const [selectedPearsonGrid, setSelectedPearsonGrid] = useState(null);
  const [selectedRainfallGrid, setSelectedRainfallGrid] = useState(null);
  const [hoveredRainfallGrid, setHoveredRainfallGrid] = useState(null);
  const [geoData, setGeoData] = useState(null);
  const [error, setError] = useState(null);
  const [focusDownloadUrl, setFocusDownloadUrl] = useState(null);
  const canvasRef = useRef(null);
  const rCanvasRef = useRef(null);

  const root = apiRoot || `${API_BASE}/api/chain/jobs/${job.jobId}`;
  const verification = job.result?.verification;
  const pearsonAvailable = Boolean(verification?.available);
  const view = pearsonAvailable ? preferredView : 'prediction';
  const caseFrame = loadedFrame?.jobId === job.jobId && loadedFrame?.view === view
    ? loadedFrame : null;
  const frame = caseFrame?.timeIndex === timeIndex ? caseFrame : null;
  const rainfallCaseKey = `${root}|${job.jobId}`;
  const rainfallPoint = selectedRainfallGrid?.caseKey === rainfallCaseKey ? selectedRainfallGrid : null;
  const hoverPoint = hoveredRainfallGrid?.caseKey === rainfallCaseKey && frame ? hoveredRainfallGrid : null;
  const rainfallValueLabel = view === 'error' ? 'Error (P − O)' : VIEW_LABELS[view];
  const pointValue = point => {
    const value = frame?.data?.[point.i]?.[point.j];
    return !frame ? 'Loading…' : Number.isFinite(value) ? `${value.toFixed(3)} mm/day` : 'No data';
  };
  const inspectRainfallPoint = (event, select = false) => {
    if (!frame) return;
    const point = rainfallGridPoint(event.clientX, event.clientY,
      event.currentTarget.getBoundingClientRect(), frame.rows, frame.cols);
    if (!point) return;
    const next = { ...point, caseKey: rainfallCaseKey };
    if (select) setSelectedRainfallGrid(next);
    else setHoveredRainfallGrid(next);
  };
  // Keep a known whole-window limit while the next date loads; never reuse
  // a scale from another case or view. Upload previews keep their daily fallback.
  const fixedScale = colorScale === 'window' || Number.isFinite(caseFrame?.scaleMax);
  const colorScaleMax = rainfallScaleMax(fixedScale ? caseFrame : frame, colorScale);

  useEffect(() => {
    const controller = new AbortController();
    fetch(GEO_URL, { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error(`Unable to load coastlines (${response.status})`);
        return response.json();
      })
      .then(setGeoData)
      .catch(err => {
        if (err.name !== 'AbortError') setError(err.message);
      });
    return () => controller.abort();
  }, []);

  // 静态演示站：CSV 下载走烘焙文件（<a href> 不经 fetch 垫片）。其他构建保持原 URL。
  useEffect(() => {
    let alive = true;
    if (!isStaticMode()) return undefined;
    staticAssetUrl(`${root}/download/focus-region`).then(url => {
      if (alive && url) setFocusDownloadUrl(url);
    });
    return () => { alive = false; };
  }, [root]);

  // 误差取同一任务、同一Day的预测减实况，沿用原始网格顺序。
  useEffect(() => {
    const controller = new AbortController();
    if (view !== 'prediction' && !pearsonAvailable) return undefined;
    const base = root;
    const readFrame = async (path) => {
      const res = await fetch(`${base}${path}?time_index=${timeIndex}`, { signal: controller.signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `Unable to load field (${res.status})`);
      return data;
    };
    const load = async () => {
      let data;
      if (view === 'error') {
        const [pred, truth] = await Promise.all([readFrame('/preview'), readFrame('/truth/preview')]);
        if (pred.rows !== truth.rows || pred.cols !== truth.cols
          || pred.timeIndex !== truth.timeIndex) throw new Error('Prediction and observation grids or dates do not match');
        const values = pred.data.map((row, i) => row.map((value, j) => (
          Number.isFinite(value) && Number.isFinite(truth.data[i]?.[j])
            ? value - truth.data[i][j] : null
        )));
        const finite = values.flat().filter(Number.isFinite);
        if (!finite.length) throw new Error('No paired prediction and observation values for this date');
        data = { ...pred, data: values, min: Math.min(...finite), max: Math.max(...finite) };
      } else {
        data = await readFrame(view === 'truth' ? '/truth/preview' : '/preview');
      }
      if (!controller.signal.aborted) {
        setFrame({ ...data, jobId: job.jobId, view });
        setError(null);
      }
    };
    load().catch(err => {
      if (err.name !== 'AbortError') setError(err.message);
    });
    return () => controller.abort();
  }, [job.jobId, timeIndex, view, pearsonAvailable, root]);

  // Fetch the correlation field and summary for the current prediction job.
  useEffect(() => {
    if (!pearsonAvailable || !showSkill) return undefined;
    const controller = new AbortController();
    fetch(`${root}/pearson`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || `Unable to load correlations (${res.status})`);
        return data;
      })
      .then(setPearson)
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err.message);
      });
    return () => controller.abort();
  }, [job.jobId, pearsonAvailable, root, showSkill]);

  useEffect(() => {
    if (!pearsonAvailable) return undefined;
    const controller = new AbortController();
    fetch(`${root}/focus-region`, { signal: controller.signal })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || `Unable to load focus-region evaluation (${res.status})`);
        return data;
      })
      .then(data => setFocusRegion({ jobId: job.jobId, data }))
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err.message);
      });
    return () => controller.abort();
  }, [job.jobId, pearsonAvailable, root]);

  useEffect(() => {
    if (!canvasRef.current) return;
    if (!frame) {
      const canvas = canvasRef.current;
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const canvas = canvasRef.current;
    canvas.width = frame.cols * CELL_SCALE;
    canvas.height = frame.rows * CELL_SCALE;
    const ctx = canvas.getContext('2d');
    const maxAbs = colorScaleMax || 1e-6;
    frame.data.forEach((row, i) => {
      row.forEach((value, j) => {
        ctx.fillStyle = Number.isFinite(value)
          ? getHeatColor(value, -(view === 'error' ? ERROR_COLOR_LIMIT : maxAbs), view === 'error' ? ERROR_COLOR_LIMIT : maxAbs)
          : '#2b2b2b';
        ctx.fillRect(
          j * CELL_SCALE,
          (frame.rows - 1 - i) * CELL_SCALE,
          CELL_SCALE,
          CELL_SCALE,
        );
      });
    });
  }, [frame, view, colorScaleMax]);

  // Correlation colors encode the r values directly.
  useEffect(() => {
    if (!pearson || !rCanvasRef.current) return;
    const canvas = rCanvasRef.current;
    canvas.width = pearson.cols * CELL_SCALE;
    canvas.height = pearson.rows * CELL_SCALE;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    pearson.data.forEach((row, i) => {
      row.forEach((value, j) => {
        const x = j * CELL_SCALE;
        const y = (pearson.rows - 1 - i) * CELL_SCALE;
        if (value === null || !Number.isFinite(value)) {
          ctx.fillStyle = '#2b2b2b';            // Undefined（时间维恒定）
        } else {
          ctx.fillStyle = getHeatColor(value);
        }
        ctx.fillRect(x, y, CELL_SCALE, CELL_SCALE);
      });
    });
  }, [pearson]);

  const handlePearsonCanvasClick = (event) => {
    if (!pearson) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const j = Math.min(
      pearson.cols - 1,
      Math.floor((event.clientX - rect.left) / rect.width * pearson.cols),
    );
    const displayRow = Math.min(
      pearson.rows - 1,
      Math.floor((event.clientY - rect.top) / rect.height * pearson.rows),
    );
    const i = pearson.rows - 1 - displayRow;
    setSelectedPearsonGrid({ i, j });
  };

  const focus = focusRegion?.jobId === job.jobId ? focusRegion.data : null;
  const focusChartData = (focus?.pred || []).map((value, index) => ({
    day: index + 1,
    date: focus?.dates?.[index] || `Day ${index + 1}`,
    prediction: value,
    truth: focus?.truth?.[index] ?? null,
  }));
  const result = job.result || {};

  const projection = job.projection || {};
  const projectionLead = String(projection.lead ?? '1');
  const leadName = projectionLead.startsWith('pre') ? projectionLead : `pre${projectionLead}`;
  const projectionYear = projection.year ?? 2000;
  const downloadCombo = `${leadName}_${projectionYear}`;
  const normalization = job.normalization || {};
  const years = projection.years || [];
  const perYear = Object.values(projection.daysPerYear || {});
  const uniformDays = perYear.length && perYear.every(v => v === perYear[0]) ? perYear[0] : null;
  const windowText = projection.window
    ? `${projection.window[0][0]}/${projection.window[0][1]} – ${projection.window[1][0]}/${projection.window[1][1]}`
    : null;
  const missing = projection.missingMonths || [];
  const missingText = missing.length
    ? `${[...new Set(missing.map(m => m[1]))].join(', ')}; ${missing.length} missing files`
    : (projection.seriesLength ? 'None' : null);

  // 只列能确定的行；.npy 入口没有投影信息，这些行自然消失
  const metaRows = [
    ['Input type', KIND_LABELS[projection.kind]
      ? `${KIND_LABELS[projection.kind]}（${KIND_SOURCE_LABELS[projection.kindSource] || '—'}）`
      : null],
    ['Projection window', windowText],
    ['Projected series', projection.seriesLength
      ? `${projection.seriesLength} samples · ${years.length} years`
        + (uniformDays ? ` × ${uniformDays} days` : '')
      : null],
    ['Missing months', missingText],
    ['Normalization', NORM_LABELS[normalization.mode] || normalization.mode || null],
    ['EOF asset', projection.matPath
      ? `${String(projection.matPath).replace(/^.*[\\/]/, '')}（${projection.matSource === 'real' ? 'Original research asset' : 'Synthetic test fixture'}）`
      : null],
  ].filter(([, value]) => value);

  return (
    <>
      {error && <div className="error-banner">⚠️ {error}</div>}
      <div className="result-row">
        <div className="result-col">
          <div className="result-card">
            <div className="result-header">
              <h3 className="result-title" style={{ margin: 0 }}>
                {view === 'error' ? 'Rainfall anomaly error' : view === 'truth' ? 'Observed rainfall anomalies' : 'Predicted rainfall anomalies'}
              </h3>
              <div className="view-toggle">
                {['prediction', 'truth', 'error'].map(kind => (
                  <button
                    key={kind}
                    type="button"
                    className={`view-toggle-btn ${view === kind ? 'is-active' : ''}`}
                    onClick={() => setView(kind)}
                    disabled={kind !== 'prediction' && !pearsonAvailable}
                    title={kind !== 'prediction' && !pearsonAvailable
                      ? 'No matching observations available'
                      : undefined}
                  >
                    {VIEW_LABELS[kind]}
                  </button>
                ))}
              </div>
            </div>
            <p className="field-meta">
              Time step {timeIndex + 1}/112 · Field range {frame ? `${frame.min.toFixed(3)} ～ ${frame.max.toFixed(3)}` : 'Loading'}
              {view !== 'prediction' && pearson?.truthName ? ` · ${pearson.truthName}` : ''}
            </p>
            {showColorScaleControl && (
              <div className="rainfall-scale-controls">
                {view === 'error' ? (
                  <p className="field-meta rainfall-scale-note">Error colors use a fixed ±{ERROR_COLOR_LIMIT} mm/day scale for all dates.</p>
                ) : (
                  <>
                    {/* Color scale selector temporarily hidden; keep the fixed-window scale.
                    <label className="rainfall-scale-label">
                      Color scale
                      <select aria-label="Rainfall color scale" value={colorScale} onChange={event => setColorScale(event.target.value)}>
                        <option value="window">Fixed 112-step field</option>
                        <option value="shared">Shared prediction &amp; observation</option>
                      </select>
                    </label>
                    */}
                    <p className="field-meta rainfall-scale-note">Fixed over 112 steps; varies by year and lead.</p>
                  </>
                )}
              </div>
            )}
            {view === 'error' ? (
              <></>
            ) : view === 'truth' ? (
              <></>
            ) : null}
            <GeoHeatmapFrame
              data={frame?.data}
              rows={frame?.rows || MAP_ROWS}
              cols={frame?.cols || MAP_COLS}
              geoData={geoData}
              showContour={false}
              selectedPoint={rainfallPoint}
            >
              <canvas
                ref={canvasRef}
                className="prediction-canvas rainfall-inspect-canvas"
                aria-label="Rainfall anomaly map"
                onMouseMove={event => inspectRainfallPoint(event)}
                onMouseLeave={() => setHoveredRainfallGrid(null)}
                onClick={event => inspectRainfallPoint(event, true)}
              />
              <GridPointTooltip point={hoverPoint} label={rainfallValueLabel}
                value={hoverPoint ? pointValue(hoverPoint) : null} />
            </GeoHeatmapFrame>
            <div className="prediction-legend">
              <span>{view === 'error' ? `Underestimate −${ERROR_COLOR_LIMIT}` : `Negative anomaly ${colorScaleMax != null ? (-colorScaleMax).toFixed(2) : '—'}`}</span>
              <div className={view === 'error' ? 'error-gradient' : 'prediction-gradient'}>
                {view === 'error' && <span className="error-gradient-zero">0</span>}
              </div>
              <span>{view === 'error' ? `Overestimate +${ERROR_COLOR_LIMIT}` : `Positive anomaly ${colorScaleMax != null ? colorScaleMax.toFixed(2) : '—'}`} mm/day</span>
            </div>
            {rainfallPoint && <div className="pearson-point-readout rainfall-point-readout" role="status" aria-label="Selected rainfall grid point">
              <span>Selected grid point</span>
              <strong>{rainfallPoint.lon.toFixed(2)}°E, {rainfallPoint.lat.toFixed(2)}°N</strong>
              <span>{rainfallValueLabel}</span>
              <strong>{pointValue(rainfallPoint)}</strong>
            </div>}
            <label className="prediction-slider-label">
              Time step
              <input
                type="range"
                min="0"
                max="111"
                value={timeIndex}
                onChange={(event) => setTimeIndex(Number(event.target.value))}
              />
            </label>
            {children}
          </div>
        </div>

        <div className="result-col">
          {/* 格点预测与实况时序图暂时停用；重点区域评价统一展示在下方。
          <div className="result-card">
            <h3 className="result-title">
              {hasTruthSeries ? '格点预测与实况时序' : '格点预测时序'}
              <span className="region-badge">({selectedGrid.j}, {selectedGrid.i})</span>
            </h3>
            {hasTruthSeries && (
              <></>
            )}
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="day" height={60} tickMargin={8} label={{ value: 'Time step', position: 'insideBottom', offset: 18 }} fontSize={11} />
                <YAxis label={{ value: 'Rainfall anomaly (mm/day)', angle: -90, position: 'insideLeft' }} fontSize={11} />
                <Tooltip formatter={(value) => Number(value).toFixed(4)} />
                <Legend />
                {hasTruthSeries && (
                  <Line type="monotone" dataKey="truth" name="实况 real2" stroke="#1a478a" dot={false} strokeWidth={2} />
                )}
                <Line
                  type="monotone"
                  dataKey="prediction"
                  name="模型预测"
                  stroke="#e63946"
                  dot={false}
                  strokeWidth={2}
                  strokeDasharray="4 2"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          */}

          {focus && (
            <div className="result-card">
              <h3 className="result-title">Focus-region prediction & observation</h3>
              <></>
              <div className="focus-series-chart">
                <div className="focus-series-axis-label">Area-mean rainfall anomaly (mm/day)</div>
                <ResponsiveContainer width="100%" height={250}>
                <LineChart data={focusChartData} margin={{ top: 14, right: 16, bottom: 14, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="day" ticks={[1, 15, 29, 43, 57, 71, 85, 99, 112]} minTickGap={24} height={60} tickMargin={8} label={{ value: 'Time step', position: 'insideBottom', offset: 18, fontSize: 12 }} fontSize={11} />
                  <YAxis width={38} fontSize={11} />
                  <Tooltip labelFormatter={(_, entries) => entries?.[0]?.payload?.date || '—'} formatter={(value) => (value == null ? '—' : String(value))} />
                  <Line type="monotone" dataKey="truth" name="Area-mean observation" stroke="#1a478a" dot={false} strokeWidth={2} />
                  <Line type="monotone" dataKey="prediction" name="Area-mean prediction" stroke="#e63946" dot={false} strokeWidth={2} strokeDasharray="4 2" />
                  <Brush dataKey="day" height={20} travellerWidth={8} stroke="#47838b" />
                </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="focus-series-legend" aria-label="Area-mean legend">
                <span className="focus-series-truth"><i />Area-mean observation</span>
                <span className="focus-series-prediction"><i />Area-mean prediction</span>
              </div>
              <div className="focus-evaluation-groups">
                <section className="focus-evaluation-group">
                  <h4>Area-mean series metrics</h4>
                  <div className="focus-metrics">
                    {[
                      ['Pearson r', focus.seriesR, ''],
                      ['RMSE', focus.rmse, 'mm/day'],
                      ['MAE', focus.mae, 'mm/day'],
                    ].map(([label, value, unit]) => (
                      <div className="focus-metric" key={label}>
                        <span>{label}</span>
                        <strong>{value == null ? 'Undefined' : value}</strong>
                        {unit && <small>{unit}</small>}
                      </div>
                    ))}
                  </div>
                </section>
                <section className="focus-evaluation-group">
                  <h4>Grid-point metrics</h4>
                  <div className="prediction-summary">
                    <span>Mean grid-point r</span><strong>{focus.meanPointR == null ? 'Undefined' : focus.meanPointR}</strong>
                    <span>Defined grid points</span><strong>{focus.definedPointR} / {focus.definedPointR + focus.undefinedPointR}</strong>
                  </div>
                </section>
              </div>
              <></>
              <a className="download-prediction-btn" href={focusDownloadUrl || `${root}/download/focus-region`} download>
                Download daily focus-region CSV
              </a>
            </div>
          )}

          {showRunSummary && <div className="result-card">
            <details className="model-run-details">
            <summary className="result-title">Model summary & downloads</summary>
            <div className="prediction-summary">
              {metaRows.map(([label, value]) => (
                <Fragment key={label}>
                  <span>{label}</span><strong>{value}</strong>
                </Fragment>
              ))}
              <span>Output shape</span><strong>{result.shape?.join(' × ')}</strong>
              <span>Minimum</span><strong>{Number(result.min).toFixed(4)}</strong>
              <span>Maximum</span><strong>{Number(result.max).toFixed(4)}</strong>
              <span>Duration</span><strong>{job.durationSeconds} s</strong>
            </div>
            {projection.matSource === 'mock' && (
              <p className="smoke-warning">
                The EOF asset is a synthetic test fixture.
                This result checks the data pipeline.<strong>Synthetic output, not a meteorological forecast</strong>。
                Use the original CIOmode_1982_2017.mat for research results.
              </p>
            )}
            {job.warning && <p className="smoke-warning">⚠️ {job.warning}</p>}
            <></>
            <a
              className="download-prediction-btn"
              href={`${API_BASE}${result.downloadUrl}`}
              download
            >
              Download prediction_{downloadCombo}.npy
            </a>
            </details>
          </div>}
        </div>
      </div>

      {verification && !pearsonAvailable && (
        <div className="result-row">
          <div className="result-col">
            <div className="result-card">
              <h3 className="result-title">Forecast skill</h3>
              <></>
            </div>
          </div>
        </div>
      )}

      {pearsonAvailable && showSkill && (
        <div className="result-row">
          <div className="result-col">
            <div className="result-card">
              <div className="result-header">
                <h3 className="result-title" style={{ margin: 0 }}>
                  Grid-point correlation · prediction vs observation
                </h3>
                <span className="region-badge">n = {pearson?.n ?? 112}</span>
              </div>
              <></>
              <></>
              <GeoHeatmapFrame
                data={pearson?.data}
                rows={pearson?.rows || MAP_ROWS}
                cols={pearson?.cols || MAP_COLS}
                geoData={geoData}
                selectedPoint={selectedPearsonGrid}
                contourLabel="r = 0.5 contour"
              >
                <canvas
                  ref={rCanvasRef}
                  className="prediction-canvas"
                  onClick={handlePearsonCanvasClick}
                  title="Pearson r; dark gray indicates an undefined correlation"
                />
              </GeoHeatmapFrame>
              {selectedPearsonGrid && pearson && (() => {
                const { i, j } = selectedPearsonGrid;
                const value = pearson.data?.[i]?.[j];
                const lon = 100 + (j * 25) / Math.max(pearson.cols - 1, 1);
                const lat = 20 + (i * 20) / Math.max(pearson.rows - 1, 1);
                const finite = Number.isFinite(value);
                return (
                  <div className="pearson-point-readout" role="status">
                    <span>Selected grid point</span>
                    <strong>{lon.toFixed(2)}°E，{lat.toFixed(2)}°N</strong>
                    <span>Pearson correlation</span>
                    <strong>{finite ? `r = ${value}` : 'r Undefined'}</strong>
                    {!finite && <span className="pearson-point-status">Undefined correlation</span>}
                  </div>
                );
              })()}
              <div className="prediction-legend">
                <span>r = -1</span>
                <div className="correlation-gradient" />
                <span>r = +1</span>
                <span className="legend-swatch legend-swatch-void" />Undefined
              </div>
            </div>
          </div>

          <div className="result-col">
            <div className="result-card">
              <h3 className="result-title">Skill summary</h3>
              {pearson ? (
                <div className="prediction-summary">
                  <span>Mean correlation</span><strong>{pearson.meanR}</strong>
                  <span>Median</span><strong>{pearson.medianR}</strong>
                  <span>Range</span><strong>{pearson.minR} ～ {pearson.maxR}</strong>
                  <span>Positive correlation</span><strong>{(pearson.positiveFraction * 100).toFixed(1)}%</strong>
                  <span>Undefined grid points</span>
                  <strong>{pearson.undefinedPoints} / {pearson.totalPoints}</strong>
                  <span>Observation</span><strong>{pearson.truthName}</strong>
                </div>
              ) : (
                <></>
              )}
              <></>
              {pearson?.downloadUrl && (
                <a
                  className="download-prediction-btn"
                  href={`${API_BASE}${pearson.downloadUrl}`}
                  download
                >
                  Download pearson_r_{downloadCombo}.npy
                </a>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
