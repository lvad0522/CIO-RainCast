import { geoGraticule10, geoOrthographic, geoPath } from 'd3-geo';

const GRATICULE = geoGraticule10();

function createLayer(size, dpr) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { canvas, ctx };
}

// Lighting does not rotate: rasterize it once instead of rebuilding gradients
// and painting every pixel on every animation frame.
export function createGlobePainter(ctx, size, dpr, land) {
  const center = size / 2;
  const radius = size * .448;
  const sphere = new Path2D();
  sphere.arc(center, center, radius, 0, Math.PI * 2);
  const projection = geoOrthographic()
    .rotate([-15, -25])
    .translate([center, center])
    .scale(radius)
    .clipAngle(90)
    // The local coastline and 2.5-degree grid already have dense vertices.
    // Avoid recursively resampling them on every rotation.
    .precision(0);
  const path = geoPath(projection, ctx);
  const background = createLayer(size, dpr);
  const foreground = createLayer(size, dpr);

  const halo = background.ctx.createRadialGradient(center, center, radius * .93, center, center, radius * 1.1);
  halo.addColorStop(0, 'rgba(71, 164, 188, 0)');
  halo.addColorStop(.48, 'rgba(76, 155, 181, .14)');
  halo.addColorStop(1, 'rgba(71, 164, 188, 0)');
  background.ctx.fillStyle = halo;
  background.ctx.fillRect(0, 0, size, size);
  const ocean = background.ctx.createRadialGradient(size * .31, size * .27, radius * .1, center, center, radius * 1.15);
  ocean.addColorStop(0, '#15425c');
  ocean.addColorStop(.62, '#0d3048');
  ocean.addColorStop(1, '#081e30');
  background.ctx.fillStyle = ocean;
  background.ctx.fill(sphere);

  const shade = foreground.ctx.createRadialGradient(size * .3, size * .26, 0, center, center, radius * 1.1);
  shade.addColorStop(0, 'rgba(199, 230, 230, .07)');
  shade.addColorStop(.67, 'rgba(3, 13, 25, 0)');
  shade.addColorStop(1, 'rgba(3, 13, 25, .49)');
  foreground.ctx.fillStyle = shade;
  foreground.ctx.fill(sphere);
  foreground.ctx.strokeStyle = 'rgba(136, 206, 223, .62)';
  foreground.ctx.lineWidth = 1;
  foreground.ctx.stroke(sphere);

  return (longitude, emphasis) => {
    projection.rotate([-longitude, -25]);
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(background.canvas, 0, 0, size, size);
    ctx.save();
    ctx.clip(sphere);
    ctx.beginPath();
    path(land);
    ctx.fillStyle = '#386773';
    ctx.fill();
    ctx.strokeStyle = 'rgba(167, 210, 212, .74)';
    ctx.lineWidth = .75;
    ctx.stroke();
    ctx.beginPath();
    path(GRATICULE);
    ctx.strokeStyle = 'rgba(97, 169, 199, .24)';
    ctx.lineWidth = .55;
    ctx.stroke();
    ctx.drawImage(foreground.canvas, 0, 0, size, size);
    if (emphasis > 0) {
      const [x, y] = projection([115, 28]);
      const glow = ctx.createRadialGradient(x, y, 0, x, y, radius * .24);
      glow.addColorStop(0, `rgba(124, 222, 215, ${.16 * emphasis})`);
      glow.addColorStop(1, 'rgba(124, 222, 215, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(x - radius * .24, y - radius * .24, radius * .48, radius * .48);
    }
    ctx.restore();
  };
}
