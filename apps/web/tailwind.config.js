/** @type {import('tailwindcss').Config} */
// D'arc Studio Design System
// Toda a escala neutra (gray/slate/zinc/neutral/stone) é substituída por tons vinhosos
// (linen → dark-maroon). Vermelhos, laranjas, pinks etc. são remapeados para a paleta
// da marca: brand-red, raspberry, sunfire, vibrant-pink, logo-pink, blue-mist.
// O vermelho da marca (#EB1C24) é sagrado — usado apenas em CTAs e elementos críticos.

// Escala neutra (substitui gray/slate/zinc/neutral/stone): Linen → Dark Maroon
const neutralWine = {
  50:  '#FDFBF6', // off-white linen (substitui o branco puro)
  100: '#FAF1E0',
  200: '#EDDBC2', // linen — neutro principal
  300: '#D4C0A3',
  400: '#A6837A',
  500: '#7E5757',
  600: '#5F3A3A',
  700: '#4F000B', // deep velvet
  800: '#391212', // dark maroon
  900: '#2A0A0A',
  950: '#1A0505',
};

// Vermelho da marca (substitui red/rose)
const brandRed = {
  50:  '#FFEEEF',
  100: '#FFD6D9',
  200: '#FFB3B8',
  300: '#F77A82',
  400: '#EE4A55',
  500: '#EB1C24', // brand-red
  600: '#C71B22',
  700: '#A1141A',
  800: '#900131', // raspberry
  900: '#6B0124',
  950: '#4F000B', // deep velvet
};

// Laranja quente (sunfire) → ponte para brand-red
const sunfire = {
  50:  '#FFF5EB',
  100: '#FFE6CC',
  200: '#FFD09E',
  300: '#FFBB73',
  400: '#F89A4F',
  500: '#F27D33', // sunfire
  600: '#D86322',
  700: '#B24A18',
  800: '#8B3712',
  900: '#6B280D',
  950: '#4F1808',
};

// Pinks (vibrant-pink + logo-pink) — substitui pink/rose/fuchsia
const brandPink = {
  50:  '#FDE9FB',
  100: '#F6CFF2', // logo-pink
  200: '#F0B4E5',
  300: '#EB91D0',
  400: '#E66BAB',
  500: '#E2366B', // vibrant-pink
  600: '#C72A5C',
  700: '#A82150',
  800: '#900131', // raspberry
  900: '#6B0124',
  950: '#4F000B',
};

// Sucesso = Raspberry (substitui green/emerald/teal/lime)
const successRaspberry = {
  50:  '#FDE9EE',
  100: '#F9C8D2',
  200: '#F098AB',
  300: '#DB6C87',
  400: '#B33F62',
  500: '#900131', // raspberry
  600: '#7A0029',
  700: '#660122',
  800: '#52001C',
  900: '#3D0015',
  950: '#28000E',
};

// Blue Mist (substitui blue/sky/cyan/indigo/violet/purple)
const blueMist = {
  50:  '#F1EAF7',
  100: '#E3D6EF',
  200: '#D2BEE3',
  300: '#BFA4D1', // blue-mist
  400: '#A88AC0',
  500: '#9171AE',
  600: '#7A5A99',
  700: '#5F4576',
  800: '#48345B',
  900: '#322642',
  950: '#1F1729',
};

module.exports = {
  content: ['./src/**/*.{ts,tsx}'],
  safelist: [
    // Project colors para sidebar dinâmico
    'bg-orange-500',
    'bg-pink-500',
    'bg-teal-500',
    'bg-blue-500',
    'bg-purple-500',
    'text-orange-600',
    'text-pink-600',
    'text-teal-600',
    'text-blue-600',
    'text-purple-600',
  ],
  theme: {
    extend: {
      colors: {
        // ── LifeOne design system (handoff tokens) ─────────────────────────
        // Fonte de verdade do rebrand. Usados explicitamente pelas telas
        // re-skinadas; convivem com os tokens `darc-*` durante a migração
        // (os overrides globais de paleta só saem no P6, após grep zero).
        lifeone: {
          blue: '#0A6CF0',        // brand accent
          canvas: '#E7E4DD',      // app canvas
          surface: '#F4F3F0',     // hub / content surface
          sidebar: '#ECEAE4',     // sidebar / chip track
          card: '#FFFFFF',
          hairline: '#DAD5CC',
          'hairline-2': '#E0DCD3',
          'hairline-3': '#ECE8E1',
          ink: '#1C1C1E',         // text primary
          'ink-2': '#6E6A63',     // secondary
          'ink-3': '#8A857C',     // tertiary
          'ink-4': '#A7A29A',     // faint
          success: '#1E924A',
          'success-fill': '#E3F6EA',
          info: '#EEF2F8',
          warning: '#B5803A',
        },
        // Acentos por tipo de projeto (fill = tint claro)
        'type-pessoal': { DEFAULT: '#0A6CF0', fill: '#E6EFFE' },
        'type-reforma': { DEFAULT: '#C2691E', fill: '#FBEBDC' },
        'type-casa':    { DEFAULT: '#1E924A', fill: '#DEF3E6' },
        'type-carro':   { DEFAULT: '#5E5A52', fill: '#EAE7E1' },
        'type-compra':  { DEFAULT: '#7A3FC2', fill: '#EFE6FA' },

        // Tokens D'arc nomeados (uso preferencial em código novo)
        darc: {
          velvet:   '#4F000B',
          maroon:   '#391212',
          red:      '#EB1C24',
          'red-bright':  '#DE342E', // brand-red usado nas laterais
          'red-pastel':  '#F77A82', // hover claro, ainda dentro do vermelho
          raspberry:'#900131',
          pink:     '#E2366B',
          'pink-logo': '#F6CFF2',
          sunfire:  '#F27D33',
          mist:     '#BFA4D1',
          linen:    '#EDDBC2',
          cream:    '#FAF1E0',
          'off-white': '#FDFBF6',
        },

        // Brand original (#3b82f6 azul) → vira brand-red da D'arc.
        // Mantém as chaves para não quebrar usos legados (`bg-brand-600` etc).
        brand: brandRed,

        // Escala de status (mantida, repintada na paleta da marca)
        status: {
          ok: '#900131',      // raspberry
          warning: '#F27D33', // sunfire
          over: '#EB1C24',    // brand-red
          info: '#BFA4D1',    // blue-mist
        },

        // Substitui cores neutras/cinza/preto/branco por tons vinhosos.
        white: '#FDFBF6',
        black: '#391212',
        gray: neutralWine,
        slate: neutralWine,
        zinc: neutralWine,
        neutral: neutralWine,
        stone: neutralWine,

        // Substitui famílias quentes → sunfire/brand-red
        orange: sunfire,
        amber: sunfire,
        yellow: sunfire,

        // Substitui vermelhos/rosas → brand-red & brand-pink
        red: brandRed,
        rose: brandPink,
        pink: brandPink,
        fuchsia: brandPink,

        // Substitui verdes/teals → raspberry (success da marca)
        green: successRaspberry,
        emerald: successRaspberry,
        teal: successRaspberry,
        lime: successRaspberry,

        // Substitui azuis/roxos → blue-mist
        blue: blueMist,
        sky: blueMist,
        cyan: blueMist,
        indigo: blueMist,
        violet: blueMist,
        purple: blueMist,
      },
      fontFamily: {
        display: ['var(--font-display)', 'Cormorant Garamond', 'Georgia', 'serif'],
        sans: ['var(--font-sans)', 'Jost', 'system-ui', 'sans-serif'],
        mono: ['Courier New', 'ui-monospace', 'monospace'],
        // LifeOne primary type (opt-in por telas re-skinadas)
        geist: ['Geist', 'var(--font-sans)', '-apple-system', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        'darc-soft':  '0 2px 16px rgba(57, 18, 18, 0.10)',
        'darc-med':   '0 4px 28px rgba(57, 18, 18, 0.18)',
        'darc-hero':  '0 8px 40px rgba(79, 0, 11, 0.30)',
        'darc-mist':  '0 4px 20px rgba(191, 164, 209, 0.25)',
        // LifeOne elevation (handoff)
        'lifeone-card':   '0 1px 3px rgba(0,0,0,.05)',
        'lifeone-hover':  '0 6px 18px rgba(0,0,0,.08)',
        'lifeone-dialog': '0 20px 50px rgba(0,0,0,.25)',
        'lifeone-fab':    '0 6px 14px rgba(10,108,240,.4)',
      },
      backgroundImage: {
        'darc-gradient-pink':  'linear-gradient(135deg, #F6CFF2 0%, #E2366B 50%, #EB1C24 100%)',
        'darc-gradient-dark':  'linear-gradient(135deg, #391212 0%, #4F000B 100%)',
        'darc-gradient-mist':  'linear-gradient(135deg, #BFA4D1 0%, #4F000B 100%)',
        'darc-gradient-warm':  'linear-gradient(135deg, #EDDBC2 0%, #F27D33 60%, #EB1C24 100%)',
      },
    },
  },
  plugins: [],
};
