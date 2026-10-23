(() => {
  const root = document.documentElement;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const degreesPerPixel = 0.12;
  let frame = null;
  function updateRotation() {
    frame = null;
    // Absolute position makes reversing, anchor jumps and restored scroll deterministic.
    const scrollPosition = Math.max(0, window.scrollY);
    const rotation = reducedMotion.matches ? 0 : scrollPosition * degreesPerPixel;
    root.style.setProperty('--scroll-angle', `${rotation}deg`);
  }
  function requestRotation() {
    if (frame === null) frame = requestAnimationFrame(updateRotation);
  }
  window.addEventListener('scroll', requestRotation, { passive: true });
  window.addEventListener('pageshow', requestRotation);
  window.addEventListener('resize', requestRotation);
  reducedMotion.addEventListener('change', requestRotation);
  updateRotation();
})();
