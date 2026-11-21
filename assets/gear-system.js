(() => {
  "use strict";

  const root = document.documentElement;
  const stations = [...document.querySelectorAll("[data-rail-station]")];
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let framePending = false;

  function applyScrollPosition() {
    framePending = false;
    const scroll = Math.max(0, window.scrollY || 0);
    const isReduced = reduceMotion.matches;

    for (const gear of document.querySelectorAll("[data-cog][data-teeth]")) {
      const teeth = Number(gear.dataset.teeth);
      const direction = Number(gear.dataset.direction || 1);
      const phase = Number(gear.dataset.phase || 0);
      if (!Number.isFinite(teeth) || teeth <= 0) continue;
      const angle = isReduced ? 0 : scroll * 0.12 * (12 / teeth) * direction + phase;
      gear.style.transform = `rotate(${angle}deg)`;
    }

    for (const station of stations) {
      const anchor = document.querySelector(station.dataset.anchor);
      if (!anchor) continue;
      const offset = Number(station.dataset.offset || 0);
      station.style.top = `${anchor.getBoundingClientRect().top + offset}px`;
    }
  }

  function scheduleUpdate() {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(applyScrollPosition);
  }

  const gearObserver = new MutationObserver(scheduleUpdate);
  gearObserver.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("scroll", scheduleUpdate, { passive: true });
  window.addEventListener("resize", scheduleUpdate, { passive: true });
  window.addEventListener("pageshow", scheduleUpdate);
  reduceMotion.addEventListener?.("change", scheduleUpdate);
  if (document.fonts?.ready) document.fonts.ready.then(scheduleUpdate);
  window.addEventListener("load", scheduleUpdate, { once: true });
  scheduleUpdate();
})();
