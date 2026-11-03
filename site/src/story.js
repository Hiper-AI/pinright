// The scroll story on the home page: a Claude Code session, then a sentence about it with empty
// braces. As you scroll, each highlighted piece of the session lifts out, leaves a dashed hole
// and drops into its braces in reading order. Without JavaScript, with reduced motion, or when
// the stage does not fit the screen, the finished sentence shows as plain HTML.
//
// Styles are set through the CSSOM (element.style), which the CSP's style-src 'self' allows.

const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);
const lerp = (a, b, t) => a + (b - a) * t;
const ramp = (p, a, b) => clamp01((p - a) / (b - a));
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOut = (x) => 1 - Math.pow(1 - clamp01(x), 3);

/** The beats, as fractions of the scroll through the section. */
const SETTLE = [0.02, 0.2]; // the session moves up to make room
const TYPE = [0.14, 0.38]; // the sentence writes itself, braces empty
const SCORE = [0.28, 0.4]; // the pieces get outlined in the session
const FLY = [0.4, 0.94]; // the pieces drop in
const FLY_LEN = 0.2;

const flightWindow = (i, n) => {
  const stagger = n > 1 ? (FLY[1] - FLY[0] - FLY_LEN) / (n - 1) : 0;
  const a = FLY[0] + i * stagger;
  return [a, a + FLY_LEN];
};
const scoreWindow = (i, n) => {
  const a = SCORE[0] + (i * (SCORE[1] - SCORE[0])) / n;
  return [a, a + 0.05];
};
const wordWindow = (w, total) => {
  const s = TYPE[0] + clamp01(w / Math.max(1, total - 1)) * (TYPE[1] - TYPE[0] - 0.06);
  return [s, s + 0.06];
};

function setup(root) {
  const stage = root.querySelector('.story-stage');
  const inner = root.querySelector('.story-in');
  const term = root.querySelector('.story-term');
  const sentence = root.querySelector('.story-sentence');
  const eyebrow = root.querySelector('.story-eyebrow');
  const caption = root.querySelector('.story-caption');
  const slots = [...sentence.querySelectorAll('.slot')];
  const n = slots.length;
  const cuts = slots.map((s) => root.querySelector(`[data-cut="${s.dataset.slot}"]`));
  const chips = slots.map((s) => s.querySelector('.chip'));
  const braces = slots.map((s) => [...s.querySelectorAll('.brace')]);

  // Words in reading order; each slot remembers how many words come before it.
  const words = [];
  const slotAt = [];
  for (const node of [...sentence.childNodes]) {
    if (node.nodeType === Node.TEXT_NODE) {
      const frag = document.createDocumentFragment();
      for (const part of node.textContent.split(/(\s+)/)) {
        if (!part) continue;
        if (/^\s+$/.test(part)) frag.append(part);
        else {
          const span = document.createElement('span');
          span.className = 'w';
          span.textContent = part;
          frag.append(span);
          words.push(span);
        }
      }
      node.replaceWith(frag);
    } else if (node.classList?.contains('slot')) slotAt.push(words.length);
  }

  // The flying copies, one per slot.
  const layer = document.createElement('div');
  layer.className = 'story-layer';
  layer.setAttribute('aria-hidden', 'true');
  const pieces = chips.map((chip) => {
    const el = document.createElement('span');
    el.className = `story-piece ${chip.className}`;
    el.textContent = chip.textContent;
    layer.append(el);
    return el;
  });
  stage.append(layer);

  let geo = null;
  let live = false;

  const rel = (el, base) => {
    const r = el.getBoundingClientRect();
    return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height };
  };

  function measure() {
    root.classList.add('is-live');
    term.style.transform = '';
    // A stage taller than the screen cannot stay pinned: show the static sentence instead.
    if (inner.scrollHeight > window.innerHeight - 16 || window.innerWidth < 360) {
      root.classList.remove('is-live');
      live = false;
      reset();
      return;
    }
    live = true;
    const base = stage.getBoundingClientRect();
    const t = rel(term, base);
    const holes = cuts.map((c) => rel(c, base));
    const targets = chips.map((c) => rel(c, base));
    const fontSize = getComputedStyle(chips[0]).fontSize;
    for (const [i, el] of pieces.entries()) {
      el.style.fontSize = fontSize;
      el.style.width = `${targets[i].w}px`;
      el.style.height = `${targets[i].h}px`;
    }
    geo = { holes, targets, termShift: base.height / 2 - (t.y + t.h / 2) };
    render(cur);
  }

  function reset() {
    for (const el of [term, eyebrow, caption, ...words, ...chips, ...braces.flat(), ...cuts]) {
      el.style.cssText = '';
    }
    for (const c of cuts) c.classList.remove('is-lifted');
    for (const el of pieces) el.style.visibility = 'hidden';
  }

  function render(p) {
    if (!live || !geo) return;
    const settle = easeInOut(ramp(p, ...SETTLE));
    term.style.transform = `translateY(${geo.termShift * (1 - settle)}px) scale(${1 + 0.05 * (1 - settle)})`;
    const head = easeOut(ramp(p, TYPE[0] - 0.04, TYPE[0] + 0.04));
    eyebrow.style.opacity = String(head);
    caption.style.opacity = String(easeOut(ramp(p, FLY[1] - 0.04, FLY[1])));

    for (const [w, el] of words.entries()) {
      const r = easeOut(ramp(p, ...wordWindow(w, words.length)));
      el.style.opacity = String(r);
      el.style.transform = r >= 1 ? '' : `translateY(${(1 - r) * 0.35}em)`;
      el.style.filter = r >= 1 ? '' : `blur(${(1 - r) * 6}px)`;
    }

    for (let i = 0; i < n; i++) {
      const [a, b] = flightWindow(i, n);
      const u = ramp(p, a, b);
      const cut = cuts[i];
      const draw = easeOut(ramp(p, ...scoreWindow(i, n)));
      cut.classList.toggle('is-lifted', u > 0);
      cut.style.boxShadow = u > 0 || draw <= 0 ? '' : `0 0 0 1.5px rgb(255 255 255 / ${(0.9 * draw).toFixed(3)})`;

      // Braces arrive with the words around them, empty, and clamp shut as the piece lands.
      const o = easeOut(ramp(p, ...wordWindow(slotAt[i] - 0.5, words.length)));
      const shut = Math.sin(Math.PI * ramp(p, b - 0.035, b + 0.025));
      const [left, right] = braces[i];
      left.style.opacity = String(o);
      right.style.opacity = String(o);
      left.style.transform = `translate(${shut * 0.12}em, ${(1 - o) * 0.35}em)`;
      right.style.transform = `translate(${-shut * 0.12}em, ${(1 - o) * 0.35}em)`;

      const el = pieces[i];
      chips[i].style.opacity = u >= 1 ? '1' : '0';
      if (u <= 0 || u >= 1) {
        el.style.visibility = 'hidden';
        continue;
      }
      const h = geo.holes[i];
      const s = geo.targets[i];
      const lift = easeOut(ramp(u, 0, 0.18));
      const t = easeInOut(ramp(u, 0.08, 0.9));
      const ax = h.x + h.w / 2;
      const ay = h.y + h.h / 2;
      const bx = s.x + s.w / 2;
      const by = s.y + s.h / 2;
      const side = bx >= ax ? 1 : -1;
      const dist = Math.hypot(bx - ax, by - ay);
      const cx = (ax + bx) / 2 + side * dist * 0.16;
      const cy = (ay + by) / 2;
      const k = 1 - t;
      const x = k * k * ax + 2 * k * t * cx + t * t * bx;
      const y = k * k * ay + 2 * k * t * cy + t * t * by - lift * k * 16;
      const breathe = Math.sin(Math.PI * t);
      const scale = lerp(h.w / s.w, 1, t) * (1 + 0.08 * breathe + 0.05 * lift * k);
      const rot = side * (5 * breathe - 2 * lift * k);
      el.style.visibility = 'visible';
      el.style.transform = `translate3d(${x - s.w / 2}px, ${y - s.h / 2}px, 0) rotate(${rot}deg) scale(${scale})`;
      el.style.boxShadow = `0 ${4 + lift * 18}px ${10 + lift * 30}px -8px rgb(0 0 0 / ${(0.35 * lift * (1 - ramp(u, 0.8, 1))).toFixed(3)})`;
    }
    root.toggleAttribute('data-settled', p >= 0.97);
  }

  // Scroll position, smoothed so the pieces glide instead of stepping with the wheel.
  let target = 0;
  let cur = 0;
  let frame = 0;
  const progress = () => {
    const r = root.getBoundingClientRect();
    const span = root.offsetHeight - window.innerHeight;
    return span > 0 ? clamp01(-r.top / span) : 1;
  };
  const tick = () => {
    cur += (target - cur) * 0.2;
    if (Math.abs(target - cur) < 0.0005) cur = target;
    render(cur);
    frame = cur === target ? 0 : requestAnimationFrame(tick);
  };
  const onScroll = () => {
    target = progress();
    if (!frame) frame = requestAnimationFrame(tick);
  };

  // After it lands, pointing at a word in the sentence shows where it came from.
  for (const [i, slot] of slots.entries()) {
    slot.addEventListener('pointerenter', () => cuts[i].classList.add('is-hot'));
    slot.addEventListener('pointerleave', () => cuts[i].classList.remove('is-hot'));
  }

  measure();
  target = cur = progress();
  render(cur);
  window.addEventListener('scroll', onScroll, { passive: true });
  let resizeFrame = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      reset();
      measure();
      onScroll();
    });
  });
  document.fonts?.ready.then(() => {
    reset();
    measure();
  });
}

const root = document.querySelector('[data-story]');
if (root && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) setup(root);
