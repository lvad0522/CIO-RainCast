// Canvas rows are drawn north-first; forecast arrays store the southern row first.
export function rainfallGridPoint(clientX, clientY, rect, rows, cols) {
  if (![clientX, clientY, rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)
    || rect.width <= 0 || rect.height <= 0 || !Number.isInteger(rows) || rows < 1
    || !Number.isInteger(cols) || cols < 1) return null;
  const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
  const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
  const j = Math.min(cols - 1, Math.floor(x / rect.width * cols));
  const i = rows - 1 - Math.min(rows - 1, Math.floor(y / rect.height * rows));
  return {
    i, j, x, y,
    lon: 100 + j * 25 / Math.max(cols - 1, 1),
    lat: 20 + i * 20 / Math.max(rows - 1, 1),
  };
}
