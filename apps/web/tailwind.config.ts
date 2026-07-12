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
        'brand-ink': 'hsl(var(--color-brand-ink) / <alpha-value>)',
        surface: 'hsl(var(--color-surface) / <alpha-value>)',
        'text-default': 'hsl(var(--color-text) / <alpha-value>)',
        border: 'hsl(var(--color-border) / <alpha-value>)',
        danger: 'hsl(var(--color-danger) / <alpha-value>)',
        success: 'hsl(var(--color-success) / <alpha-value>)',
        warning: 'hsl(var(--color-warning) / <alpha-value>)',
        info: 'hsl(var(--color-info) / <alpha-value>)',
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Text"',
          '"Segoe UI"',
          'Roboto',
          'Helvetica',
          'Arial',
          'sans-serif',
        ],
        // Numeric/tabular data (tail #s, Hobbs/tach, times) reads like a gauge.
        mono: [
          'ui-monospace',
          '"SF Mono"',
          'SFMono-Regular',
          'Menlo',
          '"Cascadia Code"',
          '"Roboto Mono"',
          'monospace',
        ],
      },
      // Tighter, architectural radius scale — structural panels read near-square;
      // only `full` stays a pill (badges, avatars) for deliberate contrast.
      borderRadius: {
        none: '0',
        sm: '2px',
        DEFAULT: '3px',
        md: '4px',
        lg: '5px',
        xl: '7px',
        '2xl': '9px',
        '3xl': '12px',
        full: '9999px',
      },
      // Hairline-first shadows: a crisp 1px ring + a whisper of depth, instead of
      // the big blurry drop shadow that reads as "template".
      boxShadow: {
        xs: '0 1px 2px 0 rgb(15 23 42 / 0.04)',
        sm: '0 1px 2px 0 rgb(15 23 42 / 0.06), 0 0 0 1px rgb(15 23 42 / 0.03)',
        DEFAULT:
          '0 1px 3px 0 rgb(15 23 42 / 0.08), 0 0 0 1px rgb(15 23 42 / 0.03)',
        md: '0 4px 12px -2px rgb(15 23 42 / 0.10), 0 0 0 1px rgb(15 23 42 / 0.04)',
        lg: '0 12px 28px -6px rgb(15 23 42 / 0.16), 0 0 0 1px rgb(15 23 42 / 0.05)',
        overlay: '0 16px 48px -12px rgb(15 23 42 / 0.28)',
      },
      letterSpacing: {
        tightish: '-0.012em',
      },
    },
  },
  plugins: [],
};

export default config;
