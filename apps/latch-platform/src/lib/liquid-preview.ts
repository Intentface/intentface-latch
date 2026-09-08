import { Liquid } from "liquidjs";

/**
 * Client-side Liquid for the extension page: render the template live against
 * the data panel (the last run's output, or sample data), and work out which
 * variables the template references so they can be checked against that data.
 * Same engine and options as `@intentface/latch-script` on the server, so the
 * preview is what the model will read.
 */

const liquid = new Liquid({ strictFilters: true, strictVariables: false });

export async function renderLiquid(template: string, scope: Record<string, unknown>): Promise<string> {
  return liquid.parseAndRender(template, scope);
}

const KEYWORDS = new Set([
  "for", "in", "endfor", "if", "elsif", "else", "endif", "unless", "endunless", "case", "when", "endcase",
  "assign", "capture", "endcapture", "increment", "decrement", "echo", "liquid", "raw", "endraw", "comment",
  "endcomment", "break", "continue", "cycle", "tablerow", "endtablerow", "render", "include", "with", "as",
  "and", "or", "not", "contains", "true", "false", "nil", "null", "empty", "blank", "limit", "offset",
  "reversed", "forloop", "tablerowloop",
]);

/**
 * Dotted paths a template reads (`output.hours`, `input.args`), minus loop
 * variables and assigned names. Filters after `|` and string literals are
 * skipped. Heuristic on purpose: it drives a checklist, not the render.
 */
export function templateRefs(template: string): string[] {
  const locals = new Set<string>();
  const refs = new Set<string>();
  const constructs = template.matchAll(/\{\{-?([\s\S]*?)-?\}\}|\{%-?([\s\S]*?)-?%\}/g);
  const exprs: string[] = [];
  for (const m of constructs) {
    if (m[1] !== undefined) exprs.push(m[1]);
    else if (m[2] !== undefined) {
      const tag = m[2].trim();
      let l = tag.match(/^(?:for|tablerow)\s+([\w$]+)\s+in\s+/);
      if (l) locals.add(l[1]!);
      l = tag.match(/^(?:assign|capture|increment|decrement)\s+([\w$]+)/);
      if (l) locals.add(l[1]!);
      exprs.push(tag);
    }
  }
  for (const raw of exprs) {
    // drop string literals and everything after a pipe's filter name is a filter, so cut at filters
    const noStrings = raw.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
    const segments = noStrings.split("|");
    // the first segment is the expression; later segments are filters with args
    const candidates = [segments[0]!, ...segments.slice(1).map((f) => f.replace(/^\s*[\w-]+\s*:?/, ""))];
    for (const c of candidates) {
      for (const p of c.matchAll(/(?<![\w$.])([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*|\[\d+\])*)/g)) {
        const path = p[1]!;
        const root = path.split(/[.[]/)[0]!;
        if (KEYWORDS.has(root) || locals.has(root) || /^\d/.test(root)) continue;
        refs.add(path.replace(/\[\d+\]/g, ""));
      }
    }
  }
  return [...refs];
}

/** Does `path` resolve in `data`? Arrays step into their first item. */
export function pathPresent(data: unknown, path: string): boolean {
  let node: unknown = data;
  for (const key of path.split(".")) {
    if (Array.isArray(node)) node = node[0];
    if (!node || typeof node !== "object" || !(key in (node as object))) return false;
    node = (node as Record<string, unknown>)[key];
  }
  return true;
}
