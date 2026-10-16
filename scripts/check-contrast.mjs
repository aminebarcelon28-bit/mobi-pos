#!/usr/bin/env node
/**
 * WCAG 2.1 AA / AA+ Contrast Ratio Verification Gate.
 *
 * Verifies that all semantic text, muted labels, and status foreground tokens
 * meet or exceed WCAG 2.1 AA contrast requirements (4.5:1 for normal text,
 * 3.0:1 for large text/muted metadata, and 3.0:1 for UI components) across
 * both Light and Dark modes.
 *
 * Formula:
 *   Relative Luminance L = 0.2126 * R + 0.7152 * G + 0.0722 * B
 *   where sRGB channels are linearized:
 *   c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
 *   Contrast Ratio = (L1 + 0.05) / (L2 + 0.05)
 */

function hexToRgb(hex) {
  const clean = hex.replace('#', '').trim();
  if (clean.length === 3) {
    return [
      parseInt(clean[0] + clean[0], 16),
      parseInt(clean[1] + clean[1], 16),
      parseInt(clean[2] + clean[2], 16),
    ];
  }
  return [
    parseInt(clean.substring(0, 2), 16),
    parseInt(clean.substring(2, 4), 16),
    parseInt(clean.substring(4, 6), 16),
  ];
}

function relativeLuminance([r, g, b]) {
  const [lr, lg, lb] = [r, g, b].map((val) => {
    const s = val / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

function contrastRatio(hex1, hex2) {
  const lum1 = relativeLuminance(hexToRgb(hex1));
  const lum2 = relativeLuminance(hexToRgb(hex2));
  const brightest = Math.max(lum1, lum2);
  const darkest = Math.min(lum1, lum2);
  return (brightest + 0.05) / (darkest + 0.05);
}

const PALETTES = {
  Light: {
    surfaces: {
      canvas: '#eef2f6',
      panel: '#f8fafc',
      card: '#ffffff',
      overlay: '#ffffff',
    },
    foregrounds: {
      'text-primary': '#0f172a',
      'text-secondary': '#334155',
      'text-muted': '#64748b',
      'status-ok': '#065f46',
      'status-warn': '#92400e',
      'status-danger': '#9f1239',
      'status-info': '#155e75',
      'status-vip': '#5b21b6',
      'status-wholesale': '#3730a3',
    },
  },
  Dark: {
    surfaces: {
      canvas: '#090d16',
      panel: '#0f172a',
      card: '#182235',
      overlay: '#1e293b',
    },
    foregrounds: {
      'text-primary': '#f1f5f9',
      'text-secondary': '#cbd5e1',
      'text-muted': '#94a3b8',
      'status-ok': '#34d399',
      'status-warn': '#fbbf24',
      'status-danger': '#fb7185',
      'status-info': '#38bdf8',
      'status-vip': '#a78bfa',
      'status-wholesale': '#818cf8',
    },
  },
};

const CHECKS = [
  { fg: 'text-primary', bg: 'canvas', min: 4.5, name: 'Primary text on Canvas' },
  { fg: 'text-primary', bg: 'panel', min: 4.5, name: 'Primary text on Panel' },
  { fg: 'text-primary', bg: 'card', min: 4.5, name: 'Primary text on Card' },
  { fg: 'text-secondary', bg: 'panel', min: 4.5, name: 'Secondary text on Panel' },
  { fg: 'text-secondary', bg: 'card', min: 4.5, name: 'Secondary text on Card' },
  { fg: 'text-muted', bg: 'card', min: 3.0, name: 'Muted text on Card (large/subtle)' },
  { fg: 'status-ok', bg: 'card', min: 4.5, name: 'Status OK foreground on Card' },
  { fg: 'status-warn', bg: 'card', min: 4.5, name: 'Status Warn foreground on Card' },
  { fg: 'status-danger', bg: 'card', min: 4.5, name: 'Status Danger foreground on Card' },
  { fg: 'status-info', bg: 'card', min: 4.5, name: 'Status Info foreground on Card' },
  { fg: 'status-vip', bg: 'card', min: 4.5, name: 'Status VIP foreground on Card' },
  { fg: 'status-wholesale', bg: 'card', min: 4.5, name: 'Status Wholesale foreground on Card' },
];

console.log('========================================================================');
console.log('WCAG 2.1 AA/AA+ CONTRAST RATIO VERIFICATION GATE');
console.log('========================================================================\n');

let totalChecks = 0;
let passedChecks = 0;
let failedChecks = 0;

for (const [mode, theme] of Object.entries(PALETTES)) {
  console.log(`--- ${mode.toUpperCase()} MODE ---`);
  for (const check of CHECKS) {
    totalChecks++;
    const fgHex = theme.foregrounds[check.fg];
    const bgHex = theme.surfaces[check.bg];
    const ratio = contrastRatio(fgHex, bgHex);
    const passed = ratio >= check.min;

    if (passed) {
      passedChecks++;
      console.log(
        `  ✅ [PASS] ${check.name.padEnd(42)}: ${ratio.toFixed(2)}:1 (>= ${check.min}:1)`
      );
    } else {
      failedChecks++;
      console.error(
        `  ❌ [FAIL] ${check.name.padEnd(42)}: ${ratio.toFixed(2)}:1 (< ${check.min}:1 Required)`
      );
    }
  }
  console.log('');
}

console.log('========================================================================');
console.log(`CONTRAST GATE SUMMARY: ${passedChecks}/${totalChecks} Passed, ${failedChecks} Failed`);
console.log('========================================================================');

if (failedChecks > 0) {
  process.exit(1);
} else {
  console.log('RESULT: All desktop token pairs exceed WCAG 2.1 AA requirements.');
  process.exit(0);
}

