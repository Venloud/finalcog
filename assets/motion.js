(() => {
  const root = document.documentElement;
  const degreesPerPixel = 0.12;
  let framePending = false;

  function updateRotation() {
    framePending = false;
    const rotation = window.scrollY * degreesPerPixel;
    root.style.setProperty('--scroll-angle', `${rotation}deg`);
    root.style.setProperty('--scroll-angle-opposite', `${rotation * -1}deg`);
  }

  function scheduleRotation() {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(updateRotation);
  }

  window.addEventListener('scroll', scheduleRotation, { passive: true });
  window.addEventListener('pageshow', scheduleRotation);
  window.addEventListener('resize', scheduleRotation);
  updateRotation();
})();
