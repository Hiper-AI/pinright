// The site's script: the theme toggle and the copy buttons, plus the scroll story, the footer and the header.
import './story.js';
import './footer.js';
import './header.js';

const KEY = 'pinright-theme';
const ORDER = ['system', 'light', 'dark'];
const root = document.documentElement;

function stored() {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

function apply(theme) {
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  try {
    if (theme === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
  for (const button of document.querySelectorAll('[data-theme-toggle]')) {
    button.dataset.state = theme;
    button.setAttribute('aria-label', `Color theme: ${theme}. Switch to ${next}.`);
  }
}

apply(stored());
for (const button of document.querySelectorAll('[data-theme-toggle]')) {
  button.addEventListener('click', () => {
    const current = button.dataset.state || 'system';
    apply(ORDER[(ORDER.indexOf(current) + 1) % ORDER.length]);
  });
}

async function writeClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.className = 'visually-hidden';
  document.body.appendChild(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}

// <div class="cmd"><pre><code>…</code></pre><button data-copy>…</button></div>. Lines that start
// with "# " are comments for the reader and are not copied; "$ " prompts are stripped.
for (const button of document.querySelectorAll('[data-copy]')) {
  const label = button.querySelector('.copy-label');
  const status = button.parentElement.querySelector('.copy-status');
  button.addEventListener('click', async () => {
    const code = button.parentElement.querySelector('code');
    const text = (button.dataset.copy || code.textContent)
      .split('\n')
      .filter((line) => !line.startsWith('# '))
      .map((line) => line.replace(/^\$ /, ''))
      .join('\n')
      .trim();
    try {
      await writeClipboard(text);
      if (label) label.textContent = 'Copied';
      if (status) status.textContent = 'Copied to the clipboard';
      window.setTimeout(() => {
        if (label) label.textContent = 'Copy';
        if (status) status.textContent = '';
      }, 1800);
    } catch {
      if (status) status.textContent = 'Copy failed. Select the text and copy it by hand.';
    }
  });
}
