export function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/** Abramowitz-Stegun 7.1.26 erf approximation (|error| < 1.5e-7). */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export function normalCdf(x: number, mean = 0, sd = 1): number {
  return 0.5 * (1 + erf((x - mean) / (sd * Math.SQRT2)));
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function mean(xs: number[]): number {
  if (xs.length === 0) throw new Error('mean of empty list');
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Closing spread -> P(home wins). CFBD spreads are home-perspective:
 * negative means the home team is favored by |spread| points.
 * Home margin ~ Normal(-spread, sd), so P(margin > 0) = Phi(-spread / sd).
 */
export function spreadToHomeProb(homeSpread: number, sd: number): number {
  return normalCdf(-homeSpread / sd);
}
