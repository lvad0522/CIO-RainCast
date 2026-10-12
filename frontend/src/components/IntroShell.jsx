import { useCallback, useEffect, useState } from 'react';
import IntroAnimation from './IntroAnimation';

const SESSION_KEY = 'cio-rain.intro-seen.v1';

function shouldPlayIntro() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  try { return sessionStorage.getItem(SESSION_KEY) !== 'yes'; }
  catch { return true; }
}

export default function IntroShell({ children }) {
  const [intro, setIntro] = useState(() => {
    const playing = shouldPlayIntro();
    return { playing, entered: !playing };
  });
  const { playing, entered } = intro;
  const complete = useCallback(() => {
    try { sessionStorage.setItem(SESSION_KEY, 'yes'); } catch { /* Storage may be unavailable. */ }
    setIntro({ playing: false, entered: true });
  }, []);

  useEffect(() => {
    const replay = () => {
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        setIntro(previous => ({ ...previous, playing: true }));
      }
    };
    window.addEventListener('cio-rain:replay-intro', replay);
    return () => window.removeEventListener('cio-rain:replay-intro', replay);
  }, []);

  return (
    <>
      {/* Defer the first chart mount; keep the mounted app on subsequent replays. */}
      <div inert={playing} aria-hidden={playing || undefined}>{entered && children}</div>
      {playing && <IntroAnimation onComplete={complete} />}
    </>
  );
}
