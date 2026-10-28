/**
 * The SAM License gate. `ensureLicence` runs before every engine start, so the app downloads and uses no SAM 3 model
 * before the user agrees. The page remembers Cancel instead of asking on every session switch.
 */
import { agreedTo, recordAgreement } from "../licence.ts";
import type { Ctx } from "./context.ts";

export function createLicenceActions(ctx: Ctx) {
  const { licence } = ctx.stores;
  const { prefs } = ctx.deps.storage;
  const shipped = ctx.deps.samLicense;

  /** Shows the licence dialog, cancelling any open one. Resolves true on "I agree" (recorded), false on Cancel. */
  function askLicence(): Promise<boolean> {
    licence.getState().ask?.answer(false);
    return new Promise((resolve) => {
      const answer = (agree: boolean) => {
        if (licence.getState().ask?.answer === answer) {
          const kept = agree && recordAgreement(prefs, shipped, new Date());
          licence.setState({ ask: null, sam: agree ? "agreed" : "declined", pageOnly: agree && !kept });
        }
        resolve(agree);
      };
      licence.setState({ ask: { answer } });
    });
  }

  /** The answer if there is one: agreed (stored, or on this page) or declined on this page. null means ask. */
  function licenceAnswer(): boolean | null {
    const { sam } = licence.getState();
    if (sam === "agreed") return true;
    if (agreedTo(prefs, shipped)) {
      licence.setState({ sam: "agreed" });
      return true;
    }
    return sam === "declined" ? false : null;
  }

  /** May the engine fetch and use the SAM 3 models? The dialog when there is no answer yet. */
  const ensureLicence = (): boolean | Promise<boolean> => licenceAnswer() ?? askLicence();

  return { askLicence, ensureLicence };
}

export type LicenceActions = ReturnType<typeof createLicenceActions>;
