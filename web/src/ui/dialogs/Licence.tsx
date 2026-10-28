/** The SAM License dialog and, after Cancel, the banner offering to review it. Escape is Cancel. */
import { useActions, useSlice } from "../context.tsx";
import { SAM_LICENCE_TEXT as T } from "../help.ts";
import { Dialog } from "./Dialog.tsx";

const SAM_LICENSE_URL = "models/LICENSE-SAM.txt";
const NOTICES_URL = "THIRD_PARTY_NOTICES.txt";

export function LicenceDialog() {
  const ask = useSlice("licence", (s) => s.ask);
  return (
    <Dialog open={!!ask} label={T.title} onClose={() => ask?.answer(false)}>
      {ask && (
        <div className="dialog licence">
          <h3>{T.title}</h3>
          <p>{T.intro}</p>
          <p>{T.points}</p>
          <p className="small">
            {T.links.before}
            <a href={SAM_LICENSE_URL} target="_blank" rel="noreferrer">
              {T.links.sam}
            </a>
            {T.links.between}
            <a href={NOTICES_URL} target="_blank" rel="noreferrer">
              {T.links.notices}
            </a>
            {T.links.after}
          </p>
          <div className="actions end">
            <button type="button" data-initial-focus onClick={() => ask.answer(false)}>
              {T.cancel}
            </button>
            <button type="button" className="primary" onClick={() => ask.answer(true)}>
              {T.agree}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function LicenceBanner() {
  const a = useActions();
  const declined = useSlice("licence", (s) => s.sam === "declined");
  if (!declined) return null;
  return (
    <div className="licence-banner" role="status">
      <span>{T.banner}</span>
      <button type="button" onClick={() => void a.reviewLicence()}>
        {T.review}
      </button>
    </div>
  );
}
