import { KnowledgeError } from "./errors.js";

/** A path as the agent writes it, split into its mount and the path inside that space. */
export interface ResolvedPath {
  /** The mount name: `practices` in `/practices/skills/x.md`; `""` for the root `/`. */
  mount: string;
  /** The path inside the space, without leading or trailing slashes; `""` for the mount itself. */
  rel: string;
}

/**
 * Splits an agent path into mount and space path. Refuses `..`, empty or
 * control-character segments, so no path can climb out of its mount.
 */
export function resolvePath(input: string): ResolvedPath {
  if (typeof input !== "string" || !input.startsWith("/")) {
    throw new KnowledgeError("invalid", `Paths start with a mount, such as /practices or /org: got "${input}"`);
  }
  const segments: string[] = [];
  for (const part of input.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") throw new KnowledgeError("invalid", `".." isn't allowed in a path: "${input}"`);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(part)) throw new KnowledgeError("invalid", `Control characters aren't allowed in a path: "${input}"`);
    segments.push(part);
  }
  const [mount = "", ...rest] = segments;
  return { mount, rel: rest.join("/") };
}

/** The agent-facing path of a file in a mount. */
export const virtualPath = (mount: string, rel: string) => (rel ? `/${mount}/${rel}` : `/${mount}`);

/** SQL that is true when the path in `pathCol` is `folderParam` or under it (`''` = everything). */
export const coversSql = (folderParam: string, pathCol: string) =>
  `(${folderParam} = '' or ${pathCol} = ${folderParam} or starts_with(${pathCol}, ${folderParam} || '/'))`;

/** A glob (`*` within a segment, `**` across segments, `?` one character) as an anchored regular expression. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === "*") {
      if (glob.charAt(i + 1) === "*") {
        i++;
        if (glob.charAt(i + 1) === "/") {
          i++;
          out += "(?:.*/)?";
        } else out += ".*";
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}
