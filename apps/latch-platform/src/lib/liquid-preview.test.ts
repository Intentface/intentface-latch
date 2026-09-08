import { describe, expect, it } from "vitest";
import { pathPresent, renderLiquid, templateRefs } from "./liquid-preview";

describe("liquid preview", () => {
  it("renders like the server engine", async () => {
    expect(await renderLiquid("Hi {{ output.name | upcase }}{% for h in output.hours %} {{ h.total }}{% endfor %}", {
      output: { name: "anna", hours: [{ total: 1 }, { total: 2 }] },
    })).toBe("Hi ANNA 1 2");
    await expect(renderLiquid("{{ x | nope }}", { x: 1 })).rejects.toThrow(/nope/);
  });

  it("lists the paths a template reads, skipping loop vars, filters, strings and keywords", () => {
    const refs = templateRefs(
      `Report for {{ input.args }}.
{% for h in output.hours %}- {{ h.name }}: {{ h.total | plus: output.bonus }}h {{ forloop.index }}{% endfor %}
{% if output.total > 10 %}{{ "literal" | append: steps.total }}{% endif %}
{% assign x = output.extra %}{{ x }}`,
    );
    expect(refs.sort()).toEqual(["input.args", "output.bonus", "output.extra", "output.hours", "output.total", "steps.total"].sort());
  });

  it("checks a path against data, stepping into arrays", () => {
    const data = { output: { hours: [{ name: "a", total: 1 }], total: 5 }, input: { args: "week" } };
    expect(pathPresent(data, "output.hours")).toBe(true);
    expect(pathPresent(data, "output.hours.total")).toBe(true);
    expect(pathPresent(data, "output.missing")).toBe(false);
    expect(pathPresent(data, "input.args")).toBe(true);
    expect(pathPresent(undefined, "output")).toBe(false);
  });
});
