/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: '#1a1a2e',
          light: '#16213e',
          dark: '#0f0f23',
        },
        accent: {
          DEFAULT: '#e94560',
          hover: '#ff6b81',
        },
      },
    },
  },
  plugins: [],
};
