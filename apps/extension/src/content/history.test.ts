import { describe, expect, it } from "vitest";
import { PreviewHistory, type PreviewDelta } from "./history";

function delta(id: string, value: string): PreviewDelta {
  return {
    id,
    selector: "#target",
    property: "color",
    value,
    previousValue: "black",
    timestamp: 1,
  };
}

describe("PreviewHistory", () => {
  it("undoes and redoes an edit batch atomically", () => {
    const history = new PreviewHistory();
    history.push([delta("one", "red"), { ...delta("two", "blue"), selector: "#other" }]);
    expect(history.snapshot()).toHaveLength(2);
    expect(history.undo()).toEqual([]);
    expect(history.state()).toEqual({ canUndo: false, canRedo: true });
    expect(history.redo()).toHaveLength(2);
  });

  it("clears redo state after a new edit", () => {
    const history = new PreviewHistory();
    history.push([delta("one", "red")]);
    history.undo();
    history.push([delta("two", "blue")]);
    expect(history.redo()).toEqual([delta("two", "blue")]);
    history.clear();
    expect(history.snapshot()).toEqual([]);
  });
});
