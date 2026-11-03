// The language switcher in the header links to the same page in the other language. Its href
// follows the #hash (on load, on every hash change), so a reader on /evidence/#latency lands on
// /es/evidence/#latency, also with a middle click. A click remembers the choice in localStorage.
// Nothing reads that choice to redirect: the site never moves a visitor to another language on its own.
const KEY = 'pinright-lang';
const links = [...document.querySelectorAll('[data-lang-switch]')];
const bases = links.map((link) => link.getAttribute('href').split('#')[0]);

const sync = () => {
  for (const [i, link] of links.entries()) link.setAttribute('href', `${bases[i]}${window.location.hash}`);
};

sync();
window.addEventListener('hashchange', sync);
for (const link of links) {
  link.addEventListener('click', () => {
    sync();
    try {
      localStorage.setItem(KEY, link.dataset.langSwitch);
    } catch {
      /* storage blocked: the link still works */
    }
  });
}
