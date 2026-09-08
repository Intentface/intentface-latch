// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { CompletionContext } from "@codemirror/autocomplete";
import { buildChips, delimiterCompletions, handleLiquidInput, liquidChips } from "./liquid-editor";

/**
 * The Liquid editor's behaviour, driven through a real EditorView in jsdom:
 * chips cover whole constructs (including empty ones being typed), `{{` and
 * `{%` auto-close with the cursor in the middle, and a lone `{` offers the two
 * delimiters.
 */

function view(doc: string, cursor = doc.length) {
  return new EditorView({
    state: EditorState.create({ doc, selection: { anchor: cursor }, extensions: [liquidChips] }),
    parent: document.body,
  });
}

function chips(v: EditorView): Array<{ text: string; kind: string }> {
  const out: Array<{ text: string; kind: string }> = [];
  const it = buildChips(v).iter();
  while (it.value) {
    const cls = (it.value.spec as { class: string }).class;
    out.push({ text: v.state.sliceDoc(it.from, it.to), kind: cls.replace("cm-liquid-chip cm-liquid-chip-", "") });
    it.next();
  }
  return out;
}

describe("chips", () => {
  it("cover whole constructs, including an empty {{ }} still being typed", () => {
    const v = view("Hi {{  }} and {% hello %}\n{% comment %}x{% endcomment %} {{ a.b | upcase }} {{ dangling");
    expect(chips(v)).toEqual([
      { text: "{{  }}", kind: "out" },
      { text: "{% hello %}", kind: "tag" },
      { text: "{% comment %}x{% endcomment %}", kind: "cmt" },
      { text: "{{ a.b | upcase }}", kind: "out" },
    ]);
  });
});

describe("typing", () => {
  it("{{ closes to `{{  }}` with the cursor in the middle; {% closes to `{%  %}`", () => {
    const a = view("Total {", 7);
    expect(handleLiquidInput(a, 7, 7, "{")).toBe(true);
    expect(a.state.doc.toString()).toBe("Total {{  }}");
    expect(a.state.selection.main.head).toBe(9);

    const b = view("{", 1);
    expect(handleLiquidInput(b, 1, 1, "%")).toBe(true);
    expect(b.state.doc.toString()).toBe("{%  %}");
    expect(b.state.selection.main.head).toBe(3);
  });

  it("leaves a construct alone when it is already closed, and ignores other characters", () => {
    const v = view("{ }}", 1);
    expect(handleLiquidInput(v, 1, 1, "{")).toBe(false);
    expect(handleLiquidInput(view("a", 1), 1, 1, "{")).toBe(false);
    expect(handleLiquidInput(view("{", 1), 1, 1, "x")).toBe(false);
  });
});

describe("delimiter completions", () => {
  const complete = (doc: string, pos = doc.length) =>
    delimiterCompletions(new CompletionContext(EditorState.create({ doc }), pos, false));

  it("a lone { offers {{ }} and {% %}; inside an open construct it stays quiet", () => {
    const r = complete("Hi {");
    expect(r?.options.map((o) => o.label)).toEqual(["{{ }}", "{% %}"]);
    expect(r?.from).toBe(3);
    expect(complete("{{ {")).toBeNull();
    expect(complete("{% if {")).toBeNull();
    expect(complete("plain")).toBeNull();
  });

  it("applying one inserts the construct with the cursor in the middle", () => {
    const v = view("Hi {", 4);
    const r = complete("Hi {")!;
    (r.options[0]!.apply as (v: EditorView, c: unknown, from: number, to: number) => void)(v, r.options[0], 3, 4);
    expect(v.state.doc.toString()).toBe("Hi {{  }}");
    expect(v.state.selection.main.head).toBe(6);
  });
});
