/** "o3 jar" / "rejected" / "unassigned" for a detection's owner. */
import type { Det } from "../../state/index.ts";
import { REJECTED } from "../../state/index.ts";
import { useDerived } from "../context.tsx";

export function useOwnerText() {
  const objs = useDerived((s) => s.objById());
  return (d: Pick<Det, "object">) => {
    if (!d.object) return "unassigned";
    if (d.object === REJECTED) return "rejected";
    return `${d.object} ${objs.get(d.object)?.label ?? ""}`;
  };
}
