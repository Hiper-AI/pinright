// Applies a theme the visitor picked before, before the first paint. Without one, CSS follows
// prefers-color-scheme. localStorage only; the site sets no cookies.
try {
  var t = localStorage.getItem('pinright-theme');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
} catch (e) {
  /* storage blocked: follow the system */
}
