import type { Similar } from "../../../state/index.ts";
import { Crop } from "../../common.tsx";
import { useActions } from "../../context.tsx";
import { useOwnerText } from "../owner.ts";

export function SimilarList({ title, list }: { readonly title: string; readonly list: readonly Similar[] }) {
  const a = useActions();
  const ownerText = useOwnerText();
  return (
    <>
      <h4>{title}</h4>
      <div className="crops">
        {list.map((s) => (
          <figure key={s.id}>
            <button
              type="button"
              className="crop-btn"
              aria-label={`Go to ${s.id} (similarity ${s.sim.toFixed(2)})`}
              onClick={() => a.goToDet(s.id)}
            >
              <Crop det={s} size={72} />
            </button>
            <figcaption>
              {s.id} · {s.sim.toFixed(2)}
              <br />
              <span className="muted">{ownerText(s)}</span>
            </figcaption>
          </figure>
        ))}
      </div>
    </>
  );
}
