/**
 * Build-time Tailwind config for the self-contained docs/showcase.html build
 * (Issue #224) — mirrors the inline `tailwind.config` the Play CDN runtime
 * used, so the compiled CSS renders byte-equivalent to the CDN build.
 *
 * Regenerate the inline CSS after editing showcase.html (then paste the output
 * into showcase.html's <style> block, replacing the previous generated block):
 *
 *   npx tailwindcss -c scripts/tailwind.showcase.config.cjs \
 *     -i scripts/showcase.tailwind.input.css \
 *     -o /tmp/showcase.inline.css --minify
 *
 * `safelist` carries the classes showcase.html toggles from JavaScript at
 * runtime (classList.add/remove on the tab panels and CTA buttons) — the
 * content scanner only sees literal strings, so runtime-only classes must be
 * listed here or the tab switcher renders unstyled after a click.
 */
module.exports = {
  darkMode: 'class',
  // Resolved relative to the CLI working directory (compile from the repo root).
  content: ['./docs/showcase.html'],
  safelist: [
    'bg-emerald-50',
    'bg-white',
    'border',
    'border-slate-200/80',
    'font-semibold',
    'hidden',
    'opacity-0',
    'shadow-sm',
    'text-emerald-600',
    'text-indigo-600',
    'text-slate-600',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      colors: {
        brand: {
          50: '#f5f3ff',
          100: '#ede9fe',
          200: '#ddd6fe',
          300: '#c4b5fd',
          400: '#a78bfa',
          500: '#8b5cf6',
          600: '#7c3aed',
          700: '#6d28d9',
          800: '#5b21b6',
          900: '#4c1d95',
        },
      },
      boxShadow: {
        'light-card': '0 4px 20px -2px rgba(15, 23, 42, 0.04), 0 2px 6px -1px rgba(15, 23, 42, 0.02)',
        'light-card-hover': '0 20px 35px -8px rgba(99, 102, 241, 0.12), 0 8px 16px -4px rgba(15, 23, 42, 0.03)',
        'mac': '0 25px 60px -15px rgba(15, 23, 42, 0.12), 0 10px 25px -5px rgba(15, 23, 42, 0.06)',
      },
    },
  },
};
