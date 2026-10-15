export default function GridPointTooltip({ point, label, value }) {
  if (!point) return null;
  return <div className="rainfall-map-tooltip" role="tooltip" style={{
    left: `clamp(8px, ${point.x + 12}px, max(8px, calc(100% - 236px)))`,
    top: `clamp(8px, ${point.y + 12}px, max(8px, calc(100% - 70px)))`,
  }}>
    <span>{point.lon.toFixed(2)}°E, {point.lat.toFixed(2)}°N</span>
    <strong>{label}: {value}</strong>
  </div>;
}
