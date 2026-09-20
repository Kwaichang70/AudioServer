/**
 * Colours come from CSS variables (R02.3), so one class carries all three
 * themes. `<alpha-value>` keeps the opacity modifiers working: `bg-white/10`
 * and `border-white/10` still mean "10% of whatever ink this theme uses".
 * The variables and the reasoning live in `src/index.css`.
 */
const withAlpha = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: withAlpha('surface'),
          light: withAlpha('surface-light'),
          dark: withAlpha('surface-dark'),
        },
        accent: {
          DEFAULT: withAlpha('accent'),
          hover: withAlpha('accent-hover'),
        },
        /** Letters on the accent colour: white in every theme. */
        'on-accent': withAlpha('on-accent'),
        white: withAlpha('white'),
        black: withAlpha('black'),
        gray: {
          200: withAlpha('gray-200'),
          300: withAlpha('gray-300'),
          400: withAlpha('gray-400'),
          500: withAlpha('gray-500'),
          600: withAlpha('gray-600'),
          700: withAlpha('gray-700'),
        },
        red: {
          200: withAlpha('red-200'),
          300: withAlpha('red-300'),
          400: withAlpha('red-400'),
          500: withAlpha('red-500'),
          900: withAlpha('red-900'),
        },
        green: {
          300: withAlpha('green-300'),
          400: withAlpha('green-400'),
          500: withAlpha('green-500'),
          900: withAlpha('green-900'),
        },
      },
    },
  },
  plugins: [],
};
