import type { Config } from 'tailwindcss';

export default {
  content: ['./src/web/src/**/*.{ts,tsx}', './src/web/index.html'],
  theme: {
    extend: {},
  },
  plugins: [],
} satisfies Config;
