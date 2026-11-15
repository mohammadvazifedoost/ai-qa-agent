/**
 * Light and dark theme. The system setting applies until the user picks one with the toggle; the
 * choice is kept in this browser. The colours themselves are in tailwind.css.
 */
export type Theme = 'light' | 'dark';

const KEY = 'ai-qa-theme';
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

export function currentTheme(): Theme {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === 'light' || chosen === 'dark') return chosen;
  return systemDark.matches ? 'dark' : 'light';
}

export function toggleTheme(): void {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Storage can be blocked (private window); the theme still applies to this page.
  }
}

/** Call `onChange` when the system setting changes, so the toggle's label stays right. */
export function watchSystemTheme(onChange: () => void): void {
  systemDark.addEventListener('change', onChange);
}
