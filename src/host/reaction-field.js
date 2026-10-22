// Floating emoji reactions on the TV, as a tiny 2D physics sim.
//
// Each reaction is a round body that rises from the bottom in a lane near
// the left or right edge (keeping the singer and lyrics in the middle
// clear). It has its own speed and a wobbly path, bounces off other
// reactions and the screen edges, and fades out on the way to the middle
// of the screen. It's gone by the halfway line.

const MAX_ITEMS = 40;
const FADE_START = 0.78;   // fraction of height (from top) where fading starts…
const FADE_END = 0.5;      // …and where it's fully gone (the middle of the screen)
const RESTITUTION = 0.85;  // bounciness of collisions
const STEP = 1 / 60;       // physics step (seconds)

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class ReactionField {
  constructor(layer) {
    this.layer = layer;
    this.items = [];
    this.raf = 0;
    this.last = 0;
    this.measure();
    new ResizeObserver(() => this.measure()).observe(layer);
  }

  measure() {
    this.w = this.layer.clientWidth || 1;
    this.h = this.layer.clientHeight || 1;
  }

  /** Launch one reaction. Ignored if the screen is already full of them. */
  add(emoji, name) {
    if (this.items.length >= MAX_ITEMS) return;
    const { w, h } = this;
    const r = Math.max(16, h * 0.045);   // body radius, roughly the emoji size
    const side = Math.random() < 0.5 ? -1 : 1;
    // Lane centre: within the outer ~20% of the screen on that side.
    const laneX = side < 0 ? rand(0.04, 0.2) * w : rand(0.8, 0.96) * w;

    const el = document.createElement('div');
    el.className = 'reaction';
    el.style.width = `${r * 2}px`;
    el.style.opacity = '0';
    const pop = document.createElement('div');
    pop.className = 'reaction-pop';
    const face = document.createElement('span');
    face.className = 'reaction-emoji';
    face.textContent = emoji;
    const who = document.createElement('span');
    who.className = 'reaction-name';
    who.textContent = String(name ?? '').slice(0, 40);
    pop.append(face, who);
    el.append(pop);
    this.layer.append(el);

    this.items.push({
      el,
      r,
      laneX,
      x: laneX + rand(-r, r),
      y: h + r,
      vx: rand(-40, 40),
      // Random rise speed: reaches the middle in roughly 1.4–3.2s.
      vy: -rand(h * 0.16, h * 0.36),
      wobbleAmp: rand(80, 220),       // px/s² sideways sway…
      wobbleFreq: rand(1.2, 3.2),     // …and how fast it sways
      phase: rand(0, Math.PI * 2),
      age: 0,
    });
    if (!this.raf) {
      this.last = performance.now();
      this.raf = requestAnimationFrame((t) => this.tick(t));
    }
  }

  tick(now) {
    // Catch up with real time in small fixed steps, so speeds stay right
    // even if the TV's browser only manages a few frames a second.
    let elapsed = Math.min(1, (now - this.last) / 1000);   // cap after long tab switches
    this.last = now;
    while (elapsed > 0) {
      const dt = Math.min(STEP, elapsed);
      this.step(dt);
      elapsed -= dt;
    }
    this.draw();
    this.raf = this.items.length ? requestAnimationFrame((t) => this.tick(t)) : 0;
  }

  /** Advance the simulation by dt seconds. */
  step(dt) {
    const { w, h, items } = this;

    for (const p of items) {
      p.age += dt;
      // Sideways forces: sway + a little jitter + a soft pull back to its lane.
      const ax =
        Math.sin(p.phase + p.age * p.wobbleFreq) * p.wobbleAmp +
        rand(-90, 90) +
        (p.laneX - p.x) * 0.8;
      p.vx = (p.vx + ax * dt) * 0.985;
      // Rise: tiny random speed changes so paths aren't perfectly smooth.
      p.vy += rand(-12, 12) * dt * 10;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      // Screen edges.
      if (p.x < p.r) {
        p.x = p.r;
        p.vx = Math.abs(p.vx) * RESTITUTION;
      } else if (p.x > w - p.r) {
        p.x = w - p.r;
        p.vx = -Math.abs(p.vx) * RESTITUTION;
      }
    }

    // Collisions: equal-mass circles, separate and bounce along the normal.
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const minD = a.r + b.r;
        const d2 = dx * dx + dy * dy;
        if (d2 >= minD * minD || d2 === 0) continue;
        const d = Math.sqrt(d2);
        const nx = dx / d;
        const ny = dy / d;
        const overlap = (minD - d) / 2;
        a.x -= nx * overlap;
        a.y -= ny * overlap;
        b.x += nx * overlap;
        b.y += ny * overlap;
        const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rel < 0) {
          const impulse = (-(1 + RESTITUTION) * rel) / 2;
          a.vx -= impulse * nx;
          a.vy -= impulse * ny;
          b.vx += impulse * nx;
          b.vy += impulse * ny;
        }
      }
    }

    // A bounce could push one downwards; nudge it back up so it always leaves.
    for (const p of items) if (p.vy > -h * 0.08) p.vy = -h * 0.08;

    // Gone once it reaches the middle of the screen.
    const fadeTop = h * FADE_END;
    this.items = items.filter((p) => {
      if (p.y > fadeTop) return true;
      p.el.remove();
      return false;
    });
  }

  /** Position and fade each reaction (fully transparent by the middle). */
  draw() {
    const fadeTop = this.h * FADE_END;
    const fadeBottom = this.h * FADE_START;
    for (const p of this.items) {
      const opacity = clamp((p.y - fadeTop) / (fadeBottom - fadeTop), 0, 1);
      p.el.style.opacity = opacity.toFixed(3);
      p.el.style.transform = `translate3d(${(p.x - p.r).toFixed(1)}px, ${(p.y - p.r).toFixed(1)}px, 0)`;
    }
  }
}
