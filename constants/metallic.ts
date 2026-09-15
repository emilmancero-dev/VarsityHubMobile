/**
 * Metallic gradient presets for bronze/silver/gold tier UI (badges, media tiles).
 * Owner rule (VARSITYHUB COMMANDMENTS, 2026-09): every bronze/silver/gold surface
 * in the app should read as a polished metal, not a flat color swatch.
 *
 * Each preset is a light-to-dark 3-stop sweep (highlight -> base metal -> shadow)
 * meant to be used with expo-linear-gradient at a diagonal angle (start {x:0.15,y:0},
 * end {x:0.85,y:1}) to read as a light source catching a curved metal surface.
 */
export const METALLIC_GRADIENTS = {
  bronze: {
    colors: ['#E7AE79', '#A0662E', '#6E4419'] as const,
    locations: [0, 0.55, 1] as const,
  },
  silver: {
    colors: ['#F5F6F8', '#AEB2B8', '#7D818A'] as const,
    locations: [0, 0.55, 1] as const,
  },
  gold: {
    colors: ['#F7E27A', '#C9A227', '#8C6A12'] as const,
    locations: [0, 0.55, 1] as const,
  },
} as const;

export type MetallicTier = keyof typeof METALLIC_GRADIENTS;
