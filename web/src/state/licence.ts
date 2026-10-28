/**
 * The SAM License agreement. The app uses SAM 3 models only after the user agrees to the exact licence text this build
 * ships. Agreed means the stored `{ sha256, at }` matches the shipped hash, so a new text asks everyone again. Storage
 * that fails or holds anything else counts as no agreement. Declining opens the session without the SAM 3 models.
 */
import { Result } from "neverthrow";
import { z } from "zod";
import type { Prefs } from "./ports.ts";
import { slice } from "./slice.ts";

/**
 * The preference key (browser prefs add the app's "eyespy." prefix).
 * @internal
 */
export const LICENCE_PREF = "licence.sam";

const AGREEMENT = z.object({ sha256: z.string(), at: z.string() });
export type Agreement = z.infer<typeof AGREEMENT>;

const storageFailed = () => "storage" as const;
const parseJson = Result.fromThrowable((text: string): unknown => JSON.parse(text), storageFailed);

/**
 * The stored agreement, or null (none, unreadable, malformed, or storage throws).
 * @internal
 */
export function readAgreement(prefs: Prefs): Agreement | null {
  const text = Result.fromThrowable(() => prefs.get(LICENCE_PREF), storageFailed)().unwrapOr(null);
  if (text === null) return null;
  const p = AGREEMENT.safeParse(parseJson(text).unwrapOr(null));
  return p.success ? p.data : null;
}

/** Agreed to `shipped` (the sha256 of the licence this build ships)? */
export const agreedTo = (prefs: Prefs, shipped: string): boolean => readAgreement(prefs)?.sha256 === shipped;

/** Stores an agreement to `shipped`. Returns true when it reads back, false when storage didn't keep it. */
export function recordAgreement(prefs: Prefs, shipped: string, at: Date): boolean {
  const record: Agreement = { sha256: shipped, at: at.toISOString() };
  const written = Result.fromThrowable(() => prefs.set(LICENCE_PREF, JSON.stringify(record)), storageFailed)();
  return written.isOk() && agreedTo(prefs, shipped);
}

export type LicenceState = {
  readonly sam: "unknown" | "agreed" | "declined";
  /** The licence dialog, while it is open. */
  readonly ask: { readonly answer: (agree: boolean) => void } | null;
  /** Agreed, but storage didn't keep it, so the next page load asks again. */
  readonly pageOnly: boolean;
};

export const createLicenceStore = () => slice<LicenceState>(() => ({ sam: "unknown", ask: null, pageOnly: false }));
