// The footer's dot field: under a mouse pointer the dots near it stay at full strength and the
// rest dim. Touch and pen keep the plain field, since there is no hover to follow.
const band = document.querySelector('[data-dither]');
const field = band?.querySelector('.df-field');
if (band && field) {
  let frame = 0;
  band.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const r = band.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      field.style.setProperty('--df-x', `${x}px`);
      field.style.setProperty('--df-y', `${y}px`);
      field.classList.add('df-lit');
    });
  });
  band.addEventListener('pointerleave', () => {
    cancelAnimationFrame(frame);
    field.classList.remove('df-lit');
  });
}

// "Back to top" is a plain link to #main; with JavaScript it scrolls smoothly unless reduced motion is on.
for (const link of document.querySelectorAll('[data-to-top]')) {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
    document.getElementById('main')?.focus({ preventScroll: true });
  });
}
