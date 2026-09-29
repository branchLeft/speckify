import type { SurfaceDiff } from '../plan.js';

/** A surface diff that finds nothing, for plan tests about the spec alone. */
export const unchangedSurface: SurfaceDiff = () => Promise.resolve({ bump: 'none', changes: [] });
