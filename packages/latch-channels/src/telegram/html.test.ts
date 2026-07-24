import { describe, expect, it } from "vitest";
import { gfmToTelegramHtml } from "./html.js";

describe("gfmToTelegramHtml", () => {
  it("escapes HTML-sensitive characters", () => {
    expect(gfmToTelegramHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });

  it("renders bold, strike, inline code and links", () => {
    expect(gfmToTelegramHtml("**bold** ~~gone~~ `x<1` [docs](https://d.example/p)")).toBe(
      '<b>bold</b> <s>gone</s> <code>x&lt;1</code> <a href="https://d.example/p">docs</a>',
    );
  });

  it("turns code fences into <pre> and does not format inside them", () => {
    expect(gfmToTelegramHtml("before\n```ts\nconst a = **not bold** <tag>;\n```\nafter")).toBe(
      "before\n<pre>const a = **not bold** &lt;tag&gt;;</pre>\nafter",
    );
  });

  it("italicizes _text_ at word boundaries only — snake_case survives", () => {
    expect(gfmToTelegramHtml("keep my_var_name but _emphasize this_ ok")).toBe(
      "keep my_var_name but <i>emphasize this</i> ok",
    );
  });
});
