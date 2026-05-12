import forms from "@tailwindcss/forms";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        review: { bg: "#fff3cd", border: "#ffc107", text: "#856404" },
        ok: { bg: "#d4edda", text: "#155724" },
        crisis: {
          critical: "#dc3545",
          high: "#fd7e14",
          medium: "#ffc107",
          low: "#6c757d",
        },
      },
      fontFamily: {
        sans: ['"Inter"', "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [forms],
};
