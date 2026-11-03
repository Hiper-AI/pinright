// The header sits flat on the page while you are at the top. Once you scroll, it gets its glass
// background, its rule and a smaller logo. A sentinel at the top of the page tells which state
// applies, so the header never reads the scroll position on every frame.
const header = document.querySelector('[data-header]');
if (header) {
  const sentinel = document.createElement('div');
  sentinel.className = 'header-sentinel';
  sentinel.setAttribute('aria-hidden', 'true');
  document.body.prepend(sentinel);
  const set = (scrolled) => header.classList.toggle('is-scrolled', scrolled);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => set(!entry.isIntersecting)).observe(sentinel);
  } else {
    const onScroll = () => set(window.scrollY > 8);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
}
