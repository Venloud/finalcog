(() => {
  "use strict";

  const root = document.documentElement;
  const stations = [...document.querySelectorAll("[data-rail-station]")];
  const railGearLayer = document.querySelector("[data-rail-gears]");
  const railGearPositions = [];
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let framePending = false;

  if (railGearLayer) {
    const gearProfiles = [
      { teeth: 12, direction: 1, phase: 0, left: 0 },
      { teeth: 24, direction: -1, phase: 7.5, left: 48 }
    ];
    for (const station of stations) {
      const anchor = document.querySelector(station.dataset.anchor);
      if (!anchor) continue;
      const offset = Number(station.dataset.offset || 0);
      for (const profile of gearProfiles) {
        const gear = document.createElement("span");
        gear.className = "gear-mark";
        gear.dataset.teeth = String(profile.teeth);
        gear.setAttribute("aria-hidden", "true");
        gear.style.left = `${profile.left}px`;

        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        const size = profile.teeth * 4;
        svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
        svg.setAttribute("aria-hidden", "true");
        const rotor = document.createElementNS("http://www.w3.org/2000/svg", "g");
        rotor.dataset.cog = "";
        rotor.dataset.teeth = String(profile.teeth);
        rotor.dataset.direction = String(profile.direction);
        rotor.dataset.phase = String(profile.phase);
        const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
        use.setAttribute("href", `assets/gear-system.svg#gear-${profile.teeth}`);
        rotor.append(use);
        svg.append(rotor);
        gear.append(svg);
        railGearLayer.append(gear);
        railGearPositions.push({ gear, anchor, offset });
      }
    }
  }

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
      const center = teeth * 2;
      gear.setAttribute("transform", `rotate(${angle} ${center} ${center})`);
    }

    for (const station of stations) {
      const anchor = document.querySelector(station.dataset.anchor);
      if (!anchor) continue;
      const offset = Number(station.dataset.offset || 0);
      station.style.top = `${anchor.getBoundingClientRect().top + offset}px`;
    }

    for (const { gear, anchor, offset } of railGearPositions) {
      const centerY = anchor.getBoundingClientRect().top + offset;
      gear.style.top = `${centerY - gear.offsetHeight / 2}px`;
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
