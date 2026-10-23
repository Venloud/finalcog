---
name: Scroll-driven cog motion
description: Project-specific requirements for visible cog rotation and reliable verification.
---

All decorative cogs on the landing page and studio must derive their angle from vertical scroll at 0.12 degrees per pixel. Apply the primary angle to the large machinery and the negated angle to secondary logo/control cogs. Coalesce scroll updates to at most one requestAnimationFrame, with no ongoing animation when scrolling stops. Keep asymmetric accent markers on rotationally symmetric gear artwork.

**Why:** The user explicitly specified smooth per-frame updates, reverse rotation for secondary cogs, and a freeze at rest. Symmetric cog outlines looked stationary without an asymmetric marker.

**How to apply:** When changing cog artwork or motion, verify real mouse-wheel movement down and up in Chromium; check positive and negative computed angles for every cog at multiple positions, confirm the angle freezes at rest, and include reduced-motion mode in the browser test.
