/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        pos: {
          bg: '#0b0f19',
          panel: '#121824',
          card: '#1a2234',
          hover: '#243046',
          border: '#2a364f',
          text: '#e2e8f0',
          muted: '#8e9bb0',
          accent: '#38bdf8',
          green: '#22c55e',
          blue: '#0284c7',
          apple: '#ffffff',
          darkApple: '#18181b',
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      }
    },
  },
  plugins: [],
}
