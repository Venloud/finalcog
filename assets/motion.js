(() => {
  const root = document.documentElement;
  const degreesPerPixel = 0.12;
  let frame = null;
  function updateRotation() {
    frame = null;
    // Absolute position makes reversing, anchor jumps and restored scroll deterministic.
    const scrollPosition = window.scrollY;
    const rotation = scrollPosition * degreesPerPixel;
    root.style.setProperty('--scroll-angle', `${rotation}deg`);
  }
  function requestRotation() {
    if (frame === null) frame = requestAnimationFrame(updateRotation);
  }
  window.addEventListener('scroll', requestRotation, { passive: true });
  window.addEventListener('pageshow', requestRotation);
  window.addEventListener('resize', requestRotation);
  updateRotation();
})();
