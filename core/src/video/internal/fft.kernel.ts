/**
 * Iterative mixed-radix complex FFT, decimation in time. Radix 2 and 4 have their own code, and other primes use a
 * small DFT. It takes any length, in float64.
 */
export class FFT {
  private readonly perm: Int32Array;
  private readonly stages: {
    p: number;
    m: number;
    twr: Float64Array;
    twi: Float64Array;
    kr: Float64Array;
    ki: Float64Array;
  }[] = [];
  private readonly xr: Float64Array;
  private readonly xi: Float64Array;
  private readonly yr: Float64Array;
  private readonly yi: Float64Array;

  constructor(readonly n: number) {
    const factors: number[] = [];
    let m = n;
    for (const p of [4, 2, 3, 5])
      while (m % p === 0) {
        factors.push(p);
        m /= p;
      }
    for (let p = 7; m > 1; p += 2)
      while (m % p === 0) {
        factors.push(p);
        m /= p;
      }
    // input index i = q0 + f0*(q1 + f1*(q2 + ...)) lands at q0*(n/f0) + q1*(n/(f0 f1)) + ...
    this.perm = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      let rem = i,
        pos = 0,
        span = n;
      for (const f of factors) {
        span /= f;
        pos += (rem % f) * span;
        rem = Math.floor(rem / f);
      }
      this.perm[pos] = i;
    }
    // Combine stages from the innermost factor outwards.
    let L = 1;
    for (const p of [...factors].reverse()) {
      const sub = L;
      L *= p;
      const twr = new Float64Array(p * sub),
        twi = new Float64Array(p * sub);
      for (let q = 0; q < p; q++)
        for (let k = 0; k < sub; k++) {
          const a = (-2 * Math.PI * q * k) / L;
          twr[q * sub + k] = Math.cos(a);
          twi[q * sub + k] = Math.sin(a);
        }
      const kr = new Float64Array(p * p),
        ki = new Float64Array(p * p);
      for (let q = 0; q < p; q++)
        for (let r = 0; r < p; r++) {
          const a = (-2 * Math.PI * ((q * r) % p)) / p;
          kr[q * p + r] = Math.cos(a);
          ki[q * p + r] = Math.sin(a);
        }
      this.stages.push({ p, m: sub, twr, twi, kr, ki });
    }
    this.xr = new Float64Array(n);
    this.xi = new Float64Array(n);
    const maxP = Math.max(1, ...factors);
    this.yr = new Float64Array(maxP);
    this.yi = new Float64Array(maxP);
  }

  /** In-place transform of (re, im) at offset and stride. `inverse` gives the unnormalised conjugate transform. */
  run(re: Float64Array, im: Float64Array, off: number, stride: number, inverse: boolean) {
    const n = this.n,
      xr = this.xr,
      xi = this.xi,
      perm = this.perm;
    const sg = inverse ? -1 : 1;
    for (let k = 0; k < n; k++) {
      const src = off + perm[k]! * stride;
      xr[k] = re[src]!;
      xi[k] = sg * im[src]!; // the inverse is conj(FFT(conj(x)))
    }
    const yr = this.yr,
      yi = this.yi;
    for (const { p, m, twr, twi, kr, ki } of this.stages) {
      const L = p * m;
      for (let b = 0; b < n; b += L) {
        for (let k = 0; k < m; k++) {
          for (let q = 0; q < p; q++) {
            const idx = b + q * m + k;
            const c = twr[q * m + k]!,
              s = twi[q * m + k]!;
            const ar = xr[idx]!,
              ai = xi[idx]!;
            yr[q] = ar * c - ai * s;
            yi[q] = ar * s + ai * c;
          }
          if (p === 2) {
            xr[b + k] = yr[0]! + yr[1]!;
            xi[b + k] = yi[0]! + yi[1]!;
            xr[b + k + m] = yr[0]! - yr[1]!;
            xi[b + k + m] = yi[0]! - yi[1]!;
          } else if (p === 4) {
            const t0r = yr[0]! + yr[2]!,
              t0i = yi[0]! + yi[2]!;
            const t1r = yr[0]! - yr[2]!,
              t1i = yi[0]! - yi[2]!;
            const t2r = yr[1]! + yr[3]!,
              t2i = yi[1]! + yi[3]!;
            const t3r = yr[1]! - yr[3]!,
              t3i = yi[1]! - yi[3]!;
            xr[b + k] = t0r + t2r;
            xi[b + k] = t0i + t2i;
            xr[b + k + 2 * m] = t0r - t2r;
            xi[b + k + 2 * m] = t0i - t2i;
            // -i * t3 for r=1, +i * t3 for r=3
            xr[b + k + m] = t1r + t3i;
            xi[b + k + m] = t1i - t3r;
            xr[b + k + 3 * m] = t1r - t3i;
            xi[b + k + 3 * m] = t1i + t3r;
          } else {
            for (let r = 0; r < p; r++) {
              let sr = 0,
                si = 0;
              for (let q = 0; q < p; q++) {
                const c = kr[q * p + r]!,
                  s = ki[q * p + r]!;
                sr += yr[q]! * c - yi[q]! * s;
                si += yr[q]! * s + yi[q]! * c;
              }
              xr[b + k + r * m] = sr;
              xi[b + k + r * m] = si;
            }
          }
        }
      }
    }
    for (let k = 0; k < n; k++) {
      re[off + k * stride] = xr[k]!;
      im[off + k * stride] = sg * xi[k]!;
    }
  }
}

export class FFT2 {
  private readonly rows: FFT;
  private readonly cols: FFT;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.rows = new FFT(w);
    this.cols = new FFT(h);
  }
  run(re: Float64Array, im: Float64Array, inverse: boolean) {
    for (let y = 0; y < this.h; y++) this.rows.run(re, im, y * this.w, 1, inverse);
    for (let x = 0; x < this.w; x++) this.cols.run(re, im, x, this.w, inverse);
  }
}
