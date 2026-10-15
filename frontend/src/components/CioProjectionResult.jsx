import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  Brush, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { getHeatColor, HEAT_COLOR_NODES } from '../utils/heatColor';

const API_BASE = import.meta.env.VITE_API_BASE || '';
// Keep the window-average summary available in code, outside the main demo.
const SHOW_REFERENCE_CONTRIBUTION_SUMMARY = false;
const U850_STAGE_TITLES = {
  input: 'Raw U850 anomaly · Central Indian Ocean',
  processed: 'Preprocessed U850 · Central Indian Ocean',
  contribution: 'CIO contribution · Central Indian Ocean',
};

const DOMAIN_LON_TICKS = [40, 60, 80, 100, 120];
const DOMAIN_LAT_TICKS = [-20, -10, 0, 10, 20];
const COASTLINE_URL = `${import.meta.env.BASE_URL}geo/cio_domain_coastline.json`;
const DIVERGING_GRADIENT = `linear-gradient(90deg, ${HEAT_COLOR_NODES
  .map(([position, color]) => `${color} ${position * 100}%`)
  .join(', ')})`;
const SEQUENTIAL_COLOR_NODES = [
  [0, '#f7fbff'],
  [0.16, '#deebf7'],
  [0.36, '#9ecae1'],
  [0.56, '#6baed6'],
  [0.74, '#3182bd'],
  [0.88, '#08519c'],
  [1, '#08306b'],
];
const SEQUENTIAL_GRADIENT = 'linear-gradient(90deg, #f7fbff 0%, #deebf7 16%, #9ecae1 36%, #6baed6 56%, #3182bd 74%, #08519c 88%, #08306b 100%)';

function formatWindow(window) {
  if (!Array.isArray(window) || window.length !== 2) return null;
  return `${window[0][0]}/${window[0][1]} – ${window[1][0]}/${window[1][1]}`;
}

function useCioDiagnostics(jobId, apiBase) {
  const [data, setData] = useState({
    capabilities: null,
    reference: null,
    mode: null,
    series: null,
    completeness: null,
    spectrum: null,
  });
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    // 任务级诊断走链路自己的端点；三个**资产端点**（capabilities/reference/
    // mode/u850）不属于任何一个任务，保持原样直接访问 /api/cio。
    const endpoints = {
      capabilities: '/api/cio/capabilities',
      reference: '/api/cio/reference',
      mode: '/api/cio/mode/u850',
      series: `/api/chain/jobs/${jobId}/series`,
      completeness: `/api/chain/jobs/${jobId}/completeness`,
    };
    Promise.all(Object.entries(endpoints).map(async ([key, path]) => {
      const response = await fetch(`${apiBase}${path}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || `${key} request failed (${response.status})`);
      return [key, payload];
    }))
      .then(entries => {
        if (alive) setData(Object.fromEntries(entries));
      })
      .catch(reason => {
        if (alive) setError(reason.message || 'Unable to load CIO diagnostics');
      });
    return () => { alive = false; };
  }, [jobId, apiBase]);

  return { data, error };
}

function EmptyPanel({ label, reason }) {
  return (
    <div className="cio-unavailable" role="status">
      <strong>{label}</strong>
      <span>{reason}</span>
    </div>
  );
}

function toFiniteNumber(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function gridShape(data) {
  if (!Array.isArray(data) || data.length === 0 || !Array.isArray(data[0]) || data[0].length === 0) {
    return null;
  }
  const cols = data[0].length;
  if (!data.every(row => Array.isArray(row) && row.length === cols)) return null;
  return { rows: data.length, cols };
}

function coordinatePair(value) {
  return Array.isArray(value)
    && toFiniteNumber(value[0]) != null
    && toFiniteNumber(value[1]) != null;
}

function cleanLine(line) {
  if (!Array.isArray(line)) return null;
  const points = line
    .filter(coordinatePair)
    .map(point => [Number(point[0]), Number(point[1])]);
  return points.length > 1 ? points : null;
}

function geometryLines(geometry) {
  if (!geometry || typeof geometry !== 'object') return [];
  if (geometry.type === 'LineString') return [geometry.coordinates];
  if (geometry.type === 'MultiLineString' || geometry.type === 'Polygon') return geometry.coordinates || [];
  if (geometry.type === 'MultiPolygon') return (geometry.coordinates || []).flat();
  if (geometry.type === 'GeometryCollection') {
    return (geometry.geometries || []).flatMap(geometryLines);
  }
  return [];
}

function lineCollection(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    if (coordinatePair(value[0])) return [value];
    return value.flatMap(lineCollection);
  }
  if (value.type === 'Feature') return geometryLines(value.geometry);
  if (value.type === 'FeatureCollection') return (value.features || []).flatMap(lineCollection);
  if (value.type) return geometryLines(value);
  return [];
}

function normalizeCoastlines(payload) {
  const normalize = value => lineCollection(value).map(cleanLine).filter(Boolean);
  return {
    coast: normalize(payload?.coast),
    borders: normalize(payload?.borders),
  };
}

function useCioDomainCoastlines() {
  const [coastlines, setCoastlines] = useState(null);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    fetch(COASTLINE_URL, { signal: controller.signal })
      .then(async response => (response.ok ? response.json() : null))
      .then(payload => {
        if (alive) setCoastlines(normalizeCoastlines(payload));
      })
      .catch(reason => {
        if (reason.name !== 'AbortError' && alive) {
          // 海岸线只是地图参考层；静态资源缺失不能阻止数值诊断展示。
          setCoastlines({ coast: [], borders: [] });
        }
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, []);

  return coastlines;
}

function axisRange(axis, fallbackStart, fallbackEnd) {
  const values = Array.isArray(axis)
    ? axis.map(toFiniteNumber).filter(value => value != null)
    : [];
  const min = values.length ? Math.min(...values) : fallbackStart;
  const max = values.length ? Math.max(...values) : fallbackEnd;
  return {
    min,
    max: max > min ? max : fallbackEnd,
    first: values[0] ?? fallbackStart,
    last: values.at(-1) ?? fallbackEnd,
  };
}

function mapAxes(lat, lon) {
  return {
    lon: axisRange(lon, 40, 120),
    lat: axisRange(lat, -20, 20),
  };
}

function mapScale(data, requestedScale, colorMode) {
  const requested = toFiniteNumber(requestedScale);
  if (requested != null && requested > 0) return requested;
  let maximum = 0;
  data.forEach(row => row.forEach(value => {
    const numeric = toFiniteNumber(value);
    if (numeric != null) {
      maximum = Math.max(maximum, colorMode === 'diverging' ? Math.abs(numeric) : numeric);
    }
  }));
  return Math.max(maximum, 1e-12);
}

function hexToRgb(hex) {
  const integer = Number.parseInt(hex.slice(1), 16);
  return [(integer >> 16) & 255, (integer >> 8) & 255, integer & 255];
}

function interpolatedColor(position, nodes) {
  const normalized = Math.max(0, Math.min(1, position));
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const [start, startColor] = nodes[index];
    const [end, endColor] = nodes[index + 1];
    if (normalized <= end) {
      const ratio = (normalized - start) / (end - start);
      const from = hexToRgb(startColor);
      const to = hexToRgb(endColor);
      const rgb = from.map((channel, channelIndex) => (
        Math.round(channel + (to[channelIndex] - channel) * ratio)
      ));
      return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
    }
  }
  return nodes.at(-1)[1];
}

function sequentialColor(value, scale) {
  const numeric = toFiniteNumber(value);
  if (numeric == null) return '#f0f0f0';
  return interpolatedColor(numeric / scale, SEQUENTIAL_COLOR_NODES);
}

function formatCoordinate(value, hemisphere) {
  const absolute = Math.abs(value);
  if (hemisphere === 'lat') {
    if (value === 0) return '0°';
    return `${absolute}°${value > 0 ? 'N' : 'S'}`;
  }
  return `${absolute}°${value >= 0 ? 'E' : 'W'}`;
}

function formatMapNumber(value, signed = false) {
  const numeric = toFiniteNumber(value);
  if (numeric == null) return '—';
  const prefix = signed && numeric > 0 ? '+' : '';
  const absolute = Math.abs(numeric);
  if (absolute > 0 && (absolute >= 1e4 || absolute < 1e-3)) {
    return `${prefix}${numeric.toExponential(2)}`;
  }
  return `${prefix}${numeric.toPrecision(3)}`;
}

function visibleTicks(ticks, range) {
  const span = range.max - range.min;
  if (!(span > 0)) return [];
  return ticks
    .filter(tick => tick >= range.min - 1e-6 && tick <= range.max + 1e-6)
    .map(tick => ({
      value: tick,
      percent: (tick - range.min) / span * 100,
    }));
}

function CoastlineOverlay({ coastlines, axes, rows, cols }) {
  const coast = coastlines?.coast || [];
  const borders = coastlines?.borders || [];
  if (!coast.length && !borders.length) return null;
  const lonSpan = axes.lon.max - axes.lon.min;
  const latSpan = axes.lat.max - axes.lat.min;
  if (!(lonSpan > 0) || !(latSpan > 0)) return null;

  const pathForLine = line => line.map(([longitude, latitude], index) => {
    const x = 0.5 + (longitude - axes.lon.min) / lonSpan * Math.max(cols - 1, 1);
    const y = 0.5 + (axes.lat.max - latitude) / latSpan * Math.max(rows - 1, 1);
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(3)},${y.toFixed(3)}`;
  }).join(' ');

  return (
    <svg
      className="coordinate-map-coastline"
      viewBox={`0 0 ${cols} ${rows}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
    >
      <g className="coordinate-map-coast">
        {coast.map((line, index) => (
          <path key={`coast-${index}`} d={pathForLine(line)} fill="none" stroke="#304a53" strokeWidth="0.52" vectorEffect="non-scaling-stroke" />
        ))}
      </g>
      <g className="coordinate-map-borders">
        {borders.map((line, index) => (
          <path key={`border-${index}`} d={pathForLine(line)} fill="none" stroke="#597078" strokeWidth="0.34" strokeDasharray="1.15 0.85" vectorEffect="non-scaling-stroke" />
        ))}
      </g>
    </svg>
  );
}

export function CoordinateMap({
  data,
  lat,
  lon,
  scaleMax,
  colorMode = 'diverging',
  coastlines,
  title,
  date,
  unit,
  className = '',
  longitudeTicks = DOMAIN_LON_TICKS,
  latitudeTicks = DOMAIN_LAT_TICKS,
  aspectRatio,
}) {
  const canvasRef = useRef(null);
  const [inspected, setInspected] = useState(null);
  const [pinned, setPinned] = useState(false);
  const shape = gridShape(data);
  const rows = shape?.rows;
  const cols = shape?.cols;
  const axes = mapAxes(lat, lon);
  const scale = shape ? mapScale(data, scaleMax, colorMode) : 1;
  const lonTicks = visibleTicks(longitudeTicks, axes.lon);
  const latTicks = visibleTicks(latitudeTicks, axes.lat);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !rows || !cols) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    canvas.width = cols;
    canvas.height = rows;
    const latAscending = axes.lat.first <= axes.lat.last;
    const lonAscending = axes.lon.first <= axes.lon.last;
    data.forEach((row, sourceRow) => {
      row.forEach((value, sourceCol) => {
        const targetRow = latAscending ? rows - sourceRow - 1 : sourceRow;
        const targetCol = lonAscending ? sourceCol : cols - sourceCol - 1;
        context.fillStyle = colorMode === 'sequential'
          ? sequentialColor(value, scale)
          : getHeatColor(value, -scale, scale);
        context.fillRect(targetCol, targetRow, 1, 1);
      });
    });
  }, [axes.lat.first, axes.lat.last, axes.lon.first, axes.lon.last, colorMode, cols, data, rows, scale]);

  if (!shape) {
    return <EmptyPanel label="Map unavailable" reason="Latitude–longitude grid missing" />;
  }

  const pickPoint = event => {
    const rect = event.currentTarget.getBoundingClientRect();
    const column = Math.max(0, Math.min(cols-1, Math.floor((event.clientX-rect.left)/rect.width*cols)));
    const row = Math.max(0, Math.min(rows-1, Math.floor((event.clientY-rect.top)/rect.height*rows)));
    return { i: axes.lat.first <= axes.lat.last ? rows-1-row : row,
             j: axes.lon.first <= axes.lon.last ? column : cols-1-column };
  };
  const inspectKeys = event => {
    if (event.key === 'Escape') { setPinned(false); setInspected(null); return; }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setPinned(value => !value);
      setInspected(point => point || { i: Math.floor(rows/2), j: Math.floor(cols/2) });
      return;
    }
    const direction = { ArrowLeft: [0,-1], ArrowRight: [0,1], ArrowUp: [1,0], ArrowDown: [-1,0] }[event.key];
    if (!direction) return;
    event.preventDefault();
    setInspected(point => ({ i: Math.max(0, Math.min(rows-1, (point?.i ?? Math.floor(rows/2))+direction[0]*(axes.lat.first <= axes.lat.last ? 1 : -1))),
                            j: Math.max(0, Math.min(cols-1, (point?.j ?? Math.floor(cols/2))+direction[1]*(axes.lon.first <= axes.lon.last ? 1 : -1))) }));
  };
  const legendStart = colorMode === 'sequential' ? '0' : formatMapNumber(-scale);
  const legendEnd = formatMapNumber(scale);
  return (
    <figure className={`coordinate-map ${className}`.trim()}>
      <figcaption className="coordinate-map-meta">
        {date && <span>Date: {date}</span>}
        {unit && <span>Unit: {unit}</span>}
      </figcaption>
      <div className="coordinate-map-body">
        <div className="coordinate-map-lat-axis" aria-hidden="true">
          {latTicks.map(tick => (
            <span
              className={`coordinate-map-lat-tick${tick.percent >= 99.999 ? ' coordinate-map-lat-tick--top' : ''}${tick.percent <= 0.001 ? ' coordinate-map-lat-tick--bottom' : ''}`}
              key={tick.value}
              style={{ top: `${100 - tick.percent}%` }}
            >
              {formatCoordinate(tick.value, 'lat')}
            </span>
          ))}
        </div>
        <div className="coordinate-map-plot" style={{ position: 'relative', overflow: 'hidden', aspectRatio: aspectRatio || `${shape.cols} / ${shape.rows}` }}>
          <canvas
            ref={canvasRef}
            className="coordinate-map-canvas projection-heatmap"
            width={shape.cols}
            height={shape.rows}
            style={{ aspectRatio: aspectRatio || `${shape.cols} / ${shape.rows}` }}
            role="button"
            tabIndex={0}
            onPointerMove={event => { if (!pinned) setInspected(pickPoint(event)); }}
            onPointerLeave={() => { if (!pinned) setInspected(null); }}
            onClick={event => { setInspected(pickPoint(event)); setPinned(value => !value); }}
            onKeyDown={inspectKeys}
            aria-label={`${title}; longitude ${formatCoordinate(axes.lon.min, 'lon')} to ${formatCoordinate(axes.lon.max, 'lon')}, latitude ${formatCoordinate(axes.lat.min, 'lat')} to ${formatCoordinate(axes.lat.max, 'lat')}`}
          />
          {inspected && <div className="map-inspection" aria-live="polite">
            {formatCoordinate(lat[inspected.i], 'lat')} · {formatCoordinate(lon[inspected.j], 'lon')}
            <strong>{formatMapNumber(data[inspected.i][inspected.j], true)} {unit}</strong>
            {pinned && <span>Pinned</span>}
          </div>}
          <div className="coordinate-map-gridlines" aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
            {lonTicks.map(tick => <span className="coordinate-map-gridline coordinate-map-gridline-lon" key={`lon-${tick.value}`} style={{ left: `${tick.percent}%` }} />)}
            {latTicks.map(tick => <span className="coordinate-map-gridline coordinate-map-gridline-lat" key={`lat-${tick.value}`} style={{ top: `${100 - tick.percent}%` }} />)}
          </div>
          <CoastlineOverlay coastlines={coastlines} axes={axes} rows={shape.rows} cols={shape.cols} />
        </div>
      </div>
      <div className="coordinate-map-lon-axis" aria-hidden="true">
        {lonTicks.map(tick => (
          <span className="coordinate-map-lon-tick" key={tick.value} style={{ left: `${tick.percent}%` }}>
            {formatCoordinate(tick.value, 'lon')}
          </span>
        ))}
      </div>
      <div className="coordinate-map-colorbar" aria-label={`${title} color scale`}>
        <span>{legendStart}</span>
        <div
          className={`coordinate-map-colorbar-gradient coordinate-map-colorbar-gradient--${colorMode}`}
          style={{ background: colorMode === 'sequential' ? SEQUENTIAL_GRADIENT : DIVERGING_GRADIENT }}
        >
          {colorMode === 'diverging' && <span className="coordinate-map-colorbar-zero">0</span>}
        </div>
        <span>{legendEnd}</span>
      </div>
    </figure>
  );
}

function ProjectionHeatmap({ stage, coastlines, date }) {
  if (!stage?.data?.length) {
    return <EmptyPanel label="Loading projection" reason="Loading prepared projection artifacts" />;
  }
  return (
    <CoordinateMap
      data={stage.data}
      lat={stage.lat}
      lon={stage.lon}
      scaleMax={stage.scaleMax}
      coastlines={coastlines}
      title={U850_STAGE_TITLES[stage.key]}
      date={date}
      unit={{ input: 'm/s', processed: 'Standardized anomaly', contribution: 'CIO contribution' }[stage.key]}
      className={`projection-coordinate-map projection-coordinate-map--${stage.key || 'stage'}`}
    />
  );
}

function ModeMap({ mode, coastlines }) {
  if (!mode) return <EmptyPanel label="Loading U850 mode" reason="Loading EOF asset" />;
  const maxAbs = Math.max(Math.abs(toFiniteNumber(mode.min) || 0), Math.abs(toFiniteNumber(mode.max) || 0), 1e-12);
  return (
    <CoordinateMap
      data={mode.data}
      lat={mode.lat}
      lon={mode.lon}
      scaleMax={mode.scaleMax || maxAbs}
      coastlines={coastlines}
      title="Stored EOF1 U850 spatial pattern"
      date="Stored mode file · spatial reference"
      unit="EOF1 loading"
      className="projection-coordinate-map projection-eof-coordinate-map"
    />
  );
}

function AverageContributionMap({ windowContribution, coastlines }) {
  const averageAbs = windowContribution?.averageAbs;
  if (!Array.isArray(averageAbs) || averageAbs.length === 0) {
    return <EmptyPanel label="Loading mean projection contribution" reason="Loading 112-day statistics" />;
  }
  const dates = windowContribution.dates || [];
  const date = dates.length > 1
    ? `${dates[0]} — ${dates[dates.length - 1]} (${dates.length}-day mean)`
    : '112-day window mean';
  return (
    <CoordinateMap
      data={averageAbs}
      lat={windowContribution.lat}
      lon={windowContribution.lon}
      scaleMax={windowContribution.scaleMax}
      colorMode="sequential"
      coastlines={coastlines}
      title="Mean absolute CIO contribution"
      date={date}
      unit="Mean |CIO contribution|"
      className="projection-coordinate-map projection-average-coordinate-map"
    />
  );
}

function ContributionSummary({ preview }) {
  const selected = preview?.selectedContribution || {};
  const positive = toFiniteNumber(selected.positiveSum);
  const negative = toFiniteNumber(selected.negativeSum);
  const net = toFiniteNumber(selected.net) ?? toFiniteNumber(preview?.contributionSum);
  const projected = toFiniteNumber(selected.projectedCio) ?? toFiniteNumber(preview?.projectedCio);
  const closure = toFiniteNumber(selected.closureError) ?? (
    net != null && projected != null ? net - projected : null
  );
  const exceedsTolerance = closure != null && Math.abs(closure) > 2e-4;
  const stats = [
    ['Positive contribution', positive],
    ['Negative contribution', negative],
    ['Net projected CIO', net],
    ['CIO series value', projected],
    ['Closure error', closure],
  ];

  return (
    <section className="projection-contribution-summary" aria-label="Grid contribution statistics">
      <h4>Central Indian Ocean projection closure</h4>
      <dl className="projection-contribution-stats">
        {stats.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{formatMapNumber(value, label !== 'Closure error')}</dd>
          </div>
        ))}
      </dl>
      {exceedsTolerance && <p className="projection-closure-note is-warning" role="alert">
        Projection closure error exceeds 2×10⁻⁴: {formatMapNumber(closure, true)}
      </p>}
    </section>
  );
}

// 2026-10-15 拖拽优化：帧按 time_index 缓存（LRU，最多 24 帧），拖动过程中停稳
// PREVIEW_SETTLE_MS 毫秒才取帧；取新帧期间继续显示上一帧——原实现每档都发一次请求，
// 且每档都先塌回 "Loading projection preview" 再重建整卡，拖动时闪烁严重。
const PREVIEW_CACHE_LIMIT = 24;
const PREVIEW_SETTLE_MS = 80;

function useProjectionPreview(jobId, enabled, timeIndex, apiBase) {
  const cacheRef = useRef(new Map());
  const [settledIndex, setSettledIndex] = useState(timeIndex);
  const [result, setResult] = useState({ jobId: null, requestKey: null, preview: null, error: null });

  // 滑块落稳后再取帧：连续拖动不为每个中间档位发请求。
  useEffect(() => {
    if (settledIndex === timeIndex) return undefined;
    const timer = setTimeout(() => setSettledIndex(timeIndex), PREVIEW_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [timeIndex, settledIndex]);

  const settledKey = jobId && enabled ? `${jobId}:${settledIndex}` : null;

  useEffect(() => {
    if (!settledKey) return undefined;
    const cachedFrame = cacheRef.current.get(settledKey);
    if (cachedFrame) {
      setResult({ jobId, requestKey: settledKey, preview: cachedFrame, error: null });
      return undefined;
    }
    const controller = new AbortController();
    fetch(`${apiBase}/api/chain/jobs/${jobId}/projection-preview?time_index=${settledIndex}`, {
      signal: controller.signal,
    })
      .then(async response => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.detail || `Unable to load projection (${response.status})`);
        return payload;
      })
      .then(payload => {
        const cache = cacheRef.current;
        cache.set(settledKey, payload);
        if (cache.size > PREVIEW_CACHE_LIMIT) cache.delete(cache.keys().next().value);
        setResult({ jobId, requestKey: settledKey, preview: payload, error: null });
      })
      .catch(reason => {
        if (reason.name !== 'AbortError') {
          setResult({ jobId, requestKey: settledKey, preview: null, error: reason.message || 'Unable to load projection' });
        }
      });
    return () => controller.abort();
  }, [jobId, settledKey, settledIndex, apiBase]);

  // 换 job（组件按 jobId 重挂载，这里兜底）→ 立刻清空；同 job 内换档 → 保留上一帧直到新帧到达。
  if (result.jobId !== jobId) return { preview: null, error: null };
  if (result.requestKey === settledKey) return { preview: result.preview, error: result.error };
  return { preview: result.preview, error: null };
}

export default function CioProjectionResult({ job, apiBase = API_BASE }) {
  const { data, error } = useCioDiagnostics(job.jobId, apiBase);
  const coastlines = useCioDomainCoastlines();
  const previewEnabled = job.projectionMode === 'u850_only'
    && (job.inputKind || job.projection?.inputKind) === 'raw-zip';
  const [previewIndex, setPreviewIndex] = useState(0);
  const { preview, error: previewError } = useProjectionPreview(
    job.jobId, previewEnabled, previewIndex, apiBase,
  );
  const projection = job.projection || {};
  const normalization = job.normalization || {};

  const chartData = useMemo(() => {
    const series = data.series;
    if (!series) return [];
    const actualByDate = new Map(
      (data.reference?.dates || []).map((item, index) => [item, data.reference.values[index]]),
    );
    return series.raw.map((projected, index) => {
      const date = series.dates?.[index] || null;
      return {
        x: date || index + 1,
        actual: date ? actualByDate.get(date) : undefined,
        projected,
      };
    });
  }, [data.reference, data.series]);

  const targetWindow = data.series?.targetWindow;
  const zoomData = targetWindow?.available
    ? chartData.slice(targetWindow.start, targetWindow.end)
    : [];
  const targetWindowDates = targetWindow?.dates;
  const targetWindowLabel = targetWindow?.available
    ? targetWindowDates?.length
      ? `(${targetWindowDates[0]} … ${targetWindowDates[targetWindowDates.length - 1]})`
      : targetWindow.year != null
        ? ` (${targetWindow.year})`
        : ''
    : '';
  // (c) 图停用，对应数据映射一并保留为注释。
//   const spectrumData = useMemo(() => {
//     const spectrum = data.spectrum;
//     if (!spectrum?.available) return [];
//     return spectrum.periodDays.map((period, index) => ({
//       period,
//       projectedPower: spectrum.projectedPower[index],
//       actualPower: spectrum.actualPower?.[index],
//     }));
//   }, [data.spectrum]);
  const calendarKnown = Boolean(data.series?.calendarKnown);
  const lineLabel = job.projectionMode === 'u850_only'
    ? 'U850 projection'
    : 'Projected CIO';
  // `.npy` 入口：① 真的没跑过，写清楚而不是留一片看着像"跑了但空"的字段
  const stage1Skipped = Boolean(projection.stage1Skipped);
  const rows = [
    ['Source', 'Global U850 anomalies · system dataset'],
    ['CIO input domain', 'Central Indian Ocean · 20°S–20°N, 40°E–120°E'],
    ['Rainfall target', 'East Asia · 20–40°N, 100–125°E'],
    ['Projection', 'U850 · EOF1'],
    ['Target year', projection.year],
    ['Lead time', `${projection.lead} days`],
    ['Samples', normalization.inputLength],
    ['Window', formatWindow(projection.window)],
  ];

  return (
    <>
      {error && <div className="error-banner">{error}</div>}
      <div className="result-card">
        <div className="result-header">
          <div>
            <h3 className="result-title" style={{ margin: 0 }}>CIO dataset overview</h3>
            <></>
          </div>
          <span className="region-badge">{job.projectionMode === 'u850_only' ? 'U850' : 'Series diagnostics'}</span>
        </div>
        {stage1Skipped && (
          <p className="chain-stage-skip">
            Projection skipped: a previously projected CIO series was supplied.
          </p>
        )}
        <div className="prediction-summary">
          {rows.map(([label, value]) => (
            <Fragment key={label}><span>{label}</span><strong>{value}</strong></Fragment>
          ))}
        </div>
        {job.warning && <p className="smoke-warning">{job.warning}</p>}

      </div>

      <div className="result-card">
        <div className="result-header">
          <div>
            <h3 className="result-title" style={{ margin: 0 }}>CIO time series</h3>
            <></>
          </div>
        </div>
        <div className="cio-figure-grid">
          <section className="cio-panel cio-panel-wide">
            <span className="cio-panel-tag">(a)</span>
            <h4>Projected CIO · 2000–2020</h4>
            {chartData.length ? (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={chartData} margin={{ top: 14, right: 16, bottom: 22, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="x" minTickGap={45} tickFormatter={value => calendarKnown ? String(value).slice(0, 7) : value} />
                  <YAxis width={44} fontSize={12} />
                  <Tooltip labelFormatter={value => calendarKnown ? value : `Sample ${value}`} />
                  {calendarKnown && <Line type="linear" dataKey="actual" name="Reference CIO (EOF PC1)" stroke="#3156a3" dot={false} connectNulls={false} strokeWidth={1.5} />}
                  <Line type="linear" dataKey="projected" name={lineLabel} stroke="#3b8734" dot={false} strokeWidth={1.2} />
                  <Brush dataKey="x" height={22} travellerWidth={8} stroke="#47838b" tickFormatter={value => String(value).slice(0, 10)} />
                </LineChart>
              </ResponsiveContainer>
            ) : <EmptyPanel label="Loading series" reason="Loading saved series" />}
          </section>

          <section className="cio-panel cio-panel-wide">
            <span className="cio-panel-tag">(b)</span>
            <h4>Target-year window · 112 days {targetWindowLabel}</h4>
            {zoomData.length ? (
              <ResponsiveContainer width="100%" height={230}>
                <LineChart data={zoomData} margin={{ top: 14, right: 16, bottom: 22, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="x" minTickGap={36} tickFormatter={value => calendarKnown ? String(value).slice(5) : value} />
                  <YAxis width={42} fontSize={12} />
                  <Tooltip />
                  {calendarKnown && <Line type="linear" dataKey="actual" name="Reference CIO (EOF PC1)" stroke="#3156a3" dot={false} strokeWidth={1.8} />}
                  <Line type="linear" dataKey="projected" name={lineLabel} stroke="#3b8734" dot={false} strokeWidth={1.5} />
                  <Brush dataKey="x" height={22} travellerWidth={8} stroke="#47838b" tickFormatter={value => String(value).slice(0, 10)} />
                </LineChart>
              </ResponsiveContainer>
            ) : targetWindow?.available === false ? (
              <EmptyPanel
                label="Target-year window unavailable"
                reason={targetWindow.reason}
              />
            ) : (
              <EmptyPanel label="Loading target window" reason="Loading saved series" />
            )}
          </section>

          {/* (c) 功率谱暂时停用；保留代码便于恢复。
          <section className="cio-panel">
            <span className="cio-panel-tag">(c)</span>
            <h4>CIO 不同时间尺度的波动强度{data.spectrum?.available ? `（${data.spectrum.blockCount} 个窗口平均）` : ''}</h4>
            {data.spectrum?.available ? (
              <ResponsiveContainer width="100%" height={230}>
                <LineChart data={spectrumData} margin={{ top: 8, right: 12, bottom: 22, left: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="period"
                    type="number"
                    scale="log"
                    domain={[5, 112]}
                    ticks={[5, 10, 20, 50, 100]}
                    allowDataOverflow
                    tickFormatter={value => `${value}`}
                    label={{ value: '周期（天）', position: 'insideBottom', offset: -12 }}
                  />
                  <YAxis
                    type="number"
                    scale="log"
                    domain={['auto', 'auto']}
                    allowDataOverflow
                    width={58}
                    tickFormatter={formatPower}
                  />
                  <Tooltip
                    labelFormatter={value => `周期 ${Number(value).toFixed(1)} 天`}
                    formatter={(value, name) => [formatPower(Number(value)), name]}
                  />
                  {data.spectrum.actualPower && (
                    <Line type="linear" dataKey="actualPower" name="实际 CIO 功率" stroke="#3156a3" dot={false} strokeWidth={1.6} />
                  )}
                  <Line type="linear" dataKey="projectedPower" name={`${lineLabel}功率`} stroke="#3b8734" dot={false} strokeWidth={1.6} />
                  <Brush dataKey="x" height={22} travellerWidth={8} stroke="#47838b" tickFormatter={value => String(value).slice(0, 10)} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <EmptyPanel
                label="当前序列不足以计算分块功率谱"
                reason={data.spectrum?.reason || '正在读取任务级频谱'}
              />
            )}
            <></>
          </section>
          */}
        </div>
        <div className="cio-line-key">
          {calendarKnown && <span><i className="is-actual" />Reference CIO (EOF PC1)</span>}
          <span><i className="is-projected" />{lineLabel}</span>

        </div>
      </div>

      {previewEnabled && (
        <div className="result-card projection-preview-card">
          <div className="result-header">
            <div>
              <h3 className="result-title" style={{ margin: 0 }}>U850 fields & CIO projection</h3>
              <></>
            </div>
            {preview && <span className="region-badge">{preview.date}</span>}
          </div>
          {preview && (
            <>
              <div className="projection-slider-row">
                <label htmlFor="projection-time-index">Projection date</label>
                <input
                  id="projection-time-index"
                  type="range"
                  min="0"
                  max={Math.max(0, preview.totalSteps - 1)}
                  value={Math.min(previewIndex, Math.max(0, preview.totalSteps - 1))}
                  onChange={event => setPreviewIndex(Number(event.target.value))}
                />
                <output>Time step {preview.timeIndex + 1} / {preview.totalSteps}</output>
              </div>
              <div className="projection-stage-grid">
                {preview.stages.map(stage => (
                  <section className="projection-stage" key={stage.key}>
                    <h4>{U850_STAGE_TITLES[stage.key]}</h4>

                    <ProjectionHeatmap stage={stage} coastlines={coastlines} date={preview.date} />
                    {stage.key === 'input' && (
                      <p className="projection-u850-sign-note">
                        U850 anomalies: red = eastward; blue = westward.
                      </p>
                    )}
                  </section>
                ))}
              </div>
              <ContributionSummary preview={preview} />
              <></>
            </>
          )}
          {!preview && !previewError && (
            <EmptyPanel label="Loading projection preview" reason="Loading prepared projection artifacts" />
          )}
          {previewError && <EmptyPanel label="Projection preview unavailable" reason={previewError} />}
        </div>
      )}

      {SHOW_REFERENCE_CONTRIBUTION_SUMMARY && <div className="result-card projection-weight-card">
        <div className="result-header">
          <h3 className="result-title" style={{ margin: 0 }}>
            {previewEnabled ? 'CIO contribution & reference EOF1 pattern' : 'Reference EOF1 pattern'} · 20°S–20°N, 40°E–120°E
          </h3>
          {data.mode && <span className="region-badge">Explained variance {data.mode.explainedVariancePercent.toFixed(1)}%</span>}
        </div>
        <div className={`projection-weight-layout${previewEnabled ? '' : ' projection-weight-layout--eof-only'}`}>
          {previewEnabled && (
            <section className="projection-weight-main">
              <h4>Mean absolute contribution · 112-day window</h4>
              {preview?.windowContribution ? (
                <AverageContributionMap windowContribution={preview.windowContribution} coastlines={coastlines} />
              ) : (
                <EmptyPanel
                  label={previewError ? 'Mean contribution unavailable' : 'Loading mean projection contribution'}
                  reason={previewError || 'Loading 112-day statistics'}
                />
              )}
              <p className="field-meta">Mean absolute grid contributions; larger values indicate stronger CIO contributions.</p>
            </section>
          )}
          <section className="projection-weight-aux">
            <h4>Stored EOF1 pattern · reference</h4>
            <ModeMap mode={data.mode} coastlines={coastlines} />
            <p className="field-meta">Stored EOF1 spatial structure, shown as a reference.</p>
          </section>
        </div>
      </div>}
    </>
  );
}
