import { Panel } from "../common.tsx";
import { useSlice } from "../context.tsx";
import { ObjectProps } from "./props/ObjectProps.tsx";
import { SearchProps } from "./props/SearchProps.tsx";
import { SelectionProps } from "./props/SelectionProps.tsx";

export function PropertiesPanel() {
  const searchRect = useSlice("selection", (s) => s.searchRect);
  const hasSelection = useSlice("selection", (s) => s.ids.length > 0);
  const obj = useSlice("selection", (s) => s.obj);
  const label = useSlice("objects", (s) => (obj ? s.objects.find((o) => o.id === obj)?.label : undefined));
  return (
    <Panel id="properties" title="Properties">
      {searchRect ? (
        <SearchProps rect={searchRect} />
      ) : hasSelection ? (
        <SelectionProps />
      ) : obj ? (
        // a fresh form when the object or its stored label changes
        <ObjectProps key={`${obj}\u0000${label ?? ""}`} oid={obj} />
      ) : (
        <div className="props muted">
          <p>Select a region on the canvas (click, shift-click to add, M to drag a box), or an object below.</p>
          <p>
            Keys: <kbd>V</kbd> select · <kbd>M</kbd> rect · <kbd>B</kbd> region search · <kbd>←</kbd>/<kbd>→</kbd>{" "}
            frames · <kbd>/</kbd> find · <kbd>A</kbd> assign to top match · <kbd>N</kbd> new object · <kbd>X</kbd>{" "}
            reject · <kbd>Ctrl+Z</kbd> undo
          </p>
        </div>
      )}
    </Panel>
  );
}
