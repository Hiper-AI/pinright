// The strings the scripts write into the page or announce, in each language of the site. The page
// language comes from <html lang>, which every page sets; anything but Spanish reads English.
export const lang = document.documentElement.lang === 'es' ? 'es' : 'en';

const STRINGS = {
  en: {
    copy: 'Copy',
    copied: 'Copied',
    copiedStatus: 'Copied to the clipboard',
    copyFailed: 'Copy failed. Select the text and copy it by hand.',
    themeLabel: (theme, next) => `Color theme: ${theme}. Switch to ${next}.`,
    theme: { system: 'system', light: 'light', dark: 'dark' },
  },
  es: {
    copy: 'Copiar',
    copied: 'Copiado',
    copiedStatus: 'Copiado al portapapeles',
    copyFailed: 'No se pudo copiar. Selecciona el texto y cópialo a mano.',
    themeLabel: (theme, next) => `Tema de color: ${theme}. Cambiar a ${next}.`,
    theme: { system: 'sistema', light: 'claro', dark: 'oscuro' },
  },
};

export const t = STRINGS[lang];
