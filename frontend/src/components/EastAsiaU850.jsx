import { useEffect, useState } from 'react';

export default function EastAsiaU850({ job, apiBase = '', timeIndex = 0, MapComponent }) {
  const year = job.projection.year;
  const lead = `pre${job.projection.lead}`;
  const [result, setResult] = useState(null);
  const [coastlines, setCoastlines] = useState(null);
  const requestKey = `${year}:${lead}:${timeIndex}`;
  const frame = result?.requestKey === requestKey ? result.frame : null;
  const error = result?.requestKey === requestKey ? result.error : null;

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${apiBase}/api/default-u850?year=${year}&lead=${lead}&time_index=${timeIndex}`, { signal: controller.signal })
      .then(async response => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.detail || 'Unable to load East Asian U850');
        return payload;
      })
      .then(payload => setResult({ requestKey, frame: payload }))
      .catch(reason => {
        if (reason.name !== 'AbortError') setResult({ requestKey, error: reason.message });
      });
    return () => controller.abort();
  }, [apiBase, year, lead, timeIndex, requestKey]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${import.meta.env.BASE_URL}geo/east_asia_coastline.json`, { signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then(setCoastlines)
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const panels = [
    { key: 'raw', title: 'U850 anomaly · East Asia', data: frame?.data, scale: frame?.scaleMax, unit: frame?.unit || 'm/s' },
    { key: 'processed', title: 'Preprocessed U850 · East Asia', data: frame?.processed, scale: frame?.processedScaleMax, unit: 'Standardized anomaly' },
  ];
  return <>{panels.map(panel => <section className="projection-stage" key={panel.key}>
    <h4>{panel.title}</h4>
    {frame && <MapComponent data={panel.data} lat={frame.lat} lon={frame.lon} scaleMax={panel.scale}
      coastlines={coastlines} title={panel.title} date={frame.date} unit={panel.unit}
      longitudeTicks={[100, 105, 110, 115, 120, 125]} latitudeTicks={[20, 25, 30, 35, 40]}
      aspectRatio="81 / 41" className="projection-coordinate-map eastasia-u850-map" />}
    {!frame && <div className="cio-unavailable" role={error ? 'alert' : 'status'}>
      <strong>{error ? 'East Asian U850 unavailable' : 'Loading East Asian U850'}</strong>
      <span>{error || 'Loading locally prepared field'}</span>
    </div>}
  </section>)}</>;
}
