import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: 'hsl(var(--color-brand) / <alpha-value>)',
        surface: 'hsl(var(--color-surface) / <alpha-value>)',
        'text-default': 'hsl(var(--color-text) / <alpha-value>)',
        border: 'hsl(var(--color-border) / <alpha-value>)',
        danger: 'hsl(var(--color-danger) / <alpha-value>)',
      },
    },
  },
  plugins: [],
};

export default config;
