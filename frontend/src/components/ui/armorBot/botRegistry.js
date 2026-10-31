// The bots shown by the hero, in cycle order (the order of the concept sheet). Each module is built by the img2threejs
// pipeline (hero-bot-workspace/bots/*.py -> spec -> generated factory -> trimmed copy) and exports createBot().
// `accent` colours the transformation glow and the rim light for that bot.
export const BOTS = [
  { id: 'base',       accent: '#2b86ff', load: () => import('./base') },
  { id: 'researcher', accent: '#2b86ff', load: () => import('./researcher') },
  { id: 'coder',      accent: '#a64bff', load: () => import('./coder') },
  { id: 'creator',    accent: '#ff4fd8', load: () => import('./creator') },
  { id: 'strategist', accent: '#ff9a1f', load: () => import('./strategist') },
  { id: 'assistant',  accent: '#29d3ff', load: () => import('./assistant') },
  { id: 'social',     accent: '#ff2d95', load: () => import('./social') },
  { id: 'automation', accent: '#3dff6a', load: () => import('./automation') },
]
