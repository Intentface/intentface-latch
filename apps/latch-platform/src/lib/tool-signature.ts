/**
 * Render a tool's JSON Schema input as something a person can read while
 * writing an extension script: a TS-ish signature, a parameter list with
 * descriptions, and a call snippet with the required parameters as tab stops.
 * Pure — used by the script editor's completions and the tools reference panel.
 */

export interface ToolParam {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  description?: string;
  additionalProperties?: boolean | Schema;
};

export function parseSchema(json: string | undefined): Schema | undefined {
  if (!json) return undefined;
  try {
    const v = JSON.parse(json) as Schema;
    return v && typeof v === "object" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** A compact TS-ish type for one schema node. */
export function typeOf(s: Schema | undefined, depth = 0): string {
  if (!s) return "unknown";
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  const alts = s.anyOf ?? s.oneOf;
  if (alts) return alts.map((a) => typeOf(a, depth + 1)).join(" | ");
  const t = Array.isArray(s.type) ? s.type.filter((x) => x !== "null").join(" | ") : s.type;
  if (t === "array") return `${typeOf(s.items, depth + 1)}[]`;
  if (t === "object" || (!t && s.properties)) {
    if (!s.properties || depth > 1) return "object";
    const req = new Set(s.required ?? []);
    const inner = Object.entries(s.properties)
      .map(([k, v]) => `${k}${req.has(k) ? "" : "?"}: ${typeOf(v, depth + 1)}`)
      .join(", ");
    return `{ ${inner} }`;
  }
  return t ?? "unknown";
}

export function paramsOf(s: Schema | undefined): ToolParam[] {
  if (!s?.properties) return [];
  const req = new Set(s.required ?? []);
  return Object.entries(s.properties).map(([name, v]) => ({
    name,
    type: typeOf(v),
    required: req.has(name),
    ...(v.description ? { description: v.description } : {}),
  }));
}

/** `clockify_hours({ period: string, limit?: number })` */
export function signatureOf(name: string, s: Schema | undefined): string {
  const params = paramsOf(s);
  if (params.length === 0) return `${name}({})`;
  return `${name}({ ${params.map((p) => `${p.name}${p.required ? "" : "?"}: ${p.type}`).join(", ")} })`;
}

/**
 * A CodeMirror snippet: `await name({ a: ${a}, b: ${b} })` with each required
 * parameter as a tab stop (optional ones are left out — they show in the
 * signature, and typing `name.` completions is not a thing in a script).
 */
export function snippetOf(name: string, s: Schema | undefined): string {
  const required = paramsOf(s).filter((p) => p.required);
  if (required.length === 0) return `await ${name}({})`;
  return `await ${name}({ ${required.map((p) => `${p.name}: \${${p.name}}`).join(", ")} })`;
}
