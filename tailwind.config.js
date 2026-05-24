/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './frontend/**/*.{html,js}',
  ],
  // Estratégia DARK por atributo data-theme (compatível com o tema do projeto)
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
        mono:    ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      colors: {
        brand:    '#14b85e',
        'brand-2': '#00d97e',
      },
    },
  },
  plugins: [],
  // Classes geradas dinamicamente via JS (innerHTML) que poderiam ser purgadas.
  // Apenas padrões válidos (sem prefixos responsive que geram warnings).
  safelist: [
    'hidden', 'block', 'inline-block', 'flex', 'grid',
    { pattern: /^(grid|flex|gap|p|m|mt|mb|ml|mr|px|py|pt|pb|pl|pr)-/ },
    { pattern: /^(text|bg|border)-(red|green|yellow|amber|emerald|slate|gray|sky|blue|purple)-(50|100|200|300|400|500|600|700|800|900)/ },
    { pattern: /^(rounded|shadow|opacity|space|leading|tracking|font|w|h|max-w|min-w|justify|items|self|order)-/ },
    { pattern: /^col-span-/ },
  ],
};
