/** "jar · calm-otter" / "rejected" / "unassigned" for a detection's owner. */
import { objName, REJECTED } from "../../state/index.ts";
import { useDerived } from "../context.tsx";

export function useOwnerText() {
  const objs = useDerived((s) => s.objById());
  return (d: { readonly object?: string | null }) => {
    if (!d.object) return "unassigned";
    if (d.object === REJECTED) return "rejected";
    return objName({ id: d.object, label: objs.get(d.object)?.label });
  };
}
