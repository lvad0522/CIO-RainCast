import { useEffect, useRef } from 'react';
import { createGlobePainter } from './introGlobe';
import { createGlobeWebGLPainter } from './introGlobeWebGL';
import './IntroAnimation.css';

const DURATION = 4000;
const clamp = value => Math.max(0, Math.min(1, value));
const smooth = value => { const t = clamp(value); return t * t * (3 - 2 * t); };

// Replays share the asset; a failed request can be retried on the next replay.
let landRequest;
function loadLand() {
  if (!landRequest) {
    landRequest = fetch(`${import.meta.env.BASE_URL}geo/intro-land.geojson`)
      .then(response => {
        if (!response.ok) throw new Error('Globe asset unavailable');
        return response.json();
      })
      .catch(error => { landRequest = undefined; throw error; });
  }
  return landRequest;
}

export default function IntroAnimation({ onComplete }) {
  const overlayRef = useRef(null);
  const canvasRef = useRef(null);
  const gpuCanvasRef = useRef(null);
  const globeRef = useRef(null);
  const skipRef = useRef(null);

  useEffect(() => {
    const overlay = overlayRef.current;
    const canvas = canvasRef.current;
    const gpuCanvas = gpuCanvasRef.current;
    const globe = globeRef.current;
    overlay.classList.remove('intro-running');
    gpuCanvas.hidden = true;
    canvas.hidden = false;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let land = null;
    let size = 0;
    let dpr = 0;
    let paint;
    let renderer;
    let dirty = true;
    let lastRotation;
    let lastEmphasis;
    let frameId;
    let finished = false;
    let started = null;
    const previousFocus = document.activeElement;
    const finish = () => {
      if (finished) return;
      finished = true;
      onComplete();
    };
    const motionChanged = () => { if (motion.matches) finish(); };
    const contextLost = event => {
      event.preventDefault();
      if (renderer) finish();
    };
    motion.addEventListener('change', motionChanged);
    gpuCanvas.addEventListener('webglcontextlost', contextLost);
    skipRef.current?.focus({ preventScroll: true });

    const resize = () => {
      const nextSize = Math.max(1, globe.getBoundingClientRect().width);
      const nextDpr = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas.width && size === nextSize && dpr === nextDpr) return;
      size = nextSize;
      dpr = nextDpr;
      if (renderer) renderer.resize(size, dpr);
      else if (paint) {
        canvas.width = Math.round(size * dpr);
        canvas.height = canvas.width;
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        paint = createGlobePainter(ctx, size, dpr, land);
      }
      dirty = true;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(globe);
    resize();

    const animate = now => {
      if (finished) return;
      const elapsed = now - started;
      // Accelerate from rest, then ease into the final East Asia view.
      const rotation = smooth(elapsed / 2400);
      const brand = smooth((elapsed - 1400) / 650);
      if (dirty || rotation !== lastRotation || brand !== lastEmphasis) {
        paint(15 + 100 * rotation, brand);
        lastRotation = rotation;
        lastEmphasis = brand;
        dirty = false;
      }
      if (elapsed >= DURATION) finish();
      else frameId = requestAnimationFrame(animate);
    };
    // Start the four-second timeline only when the complete globe is drawable.
    // CSS handles fades/transforms on the compositor, independently of rAF.
    loadLand().then(data => {
      if (finished) return;
      window.clearTimeout(assetTimeout);
      land = data;
      renderer = createGlobeWebGLPainter(gpuCanvas, land);
      if (renderer) {
        renderer.resize(size, dpr);
        paint = renderer.paint;
        gpuCanvas.hidden = false;
        canvas.hidden = true;
        gpuCanvas.dataset.introRenderer = 'webgl';
      } else {
        gpuCanvas.hidden = true;
        canvas.hidden = false;
        const ctx = canvas.getContext('2d');
        if (!ctx) { finish(); return; }
        canvas.width = Math.round(size * dpr);
        canvas.height = canvas.width;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        paint = createGlobePainter(ctx, size, dpr, land);
        canvas.dataset.introRenderer = '2d';
      }
      paint(15, 0);
      // Present the first frame before starting visible motion. This keeps GPU
      // upload/compilation outside the four-second animation timeline.
      frameId = requestAnimationFrame(() => {
        if (finished) return;
        frameId = requestAnimationFrame(now => {
          if (finished) return;
          started = now;
          overlay.classList.add('intro-running');
          frameId = requestAnimationFrame(animate);
        });
      });
    }).catch(() => { if (!finished) finish(); });
    const assetTimeout = window.setTimeout(finish, 5000);
    return () => {
      finished = true;
      cancelAnimationFrame(frameId);
      observer.disconnect();
      window.clearTimeout(assetTimeout);
      renderer?.dispose();
      motion.removeEventListener('change', motionChanged);
      gpuCanvas.removeEventListener('webglcontextlost', contextLost);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [onComplete]);

  return (
    <div
      className="intro-animation" ref={overlayRef}
      role="dialog" aria-modal="true" aria-label="CIO-RainCast opening animation"
      onKeyDown={event => { if (event.key === 'Escape') onComplete(); }}
    >
      <div className="intro-composition" lang="en">
        <div className="intro-globe" ref={globeRef}>
          <canvas ref={gpuCanvasRef} hidden aria-hidden="true" />
          <canvas ref={canvasRef} aria-hidden="true" />
        </div>
        <div className="intro-wordmark">
          <h1>CIO-RainCast</h1>
          <p>
            <span>East Asian Summer Monsoon</span>
            <span>Intraseasonal Rainfall</span>
            <span>Prediction</span>
          </p>
        </div>
      </div>
      <button className="intro-skip" ref={skipRef} onClick={onComplete}>Skip intro <span aria-hidden="true">↗</span></button>
    </div>
  );
}
