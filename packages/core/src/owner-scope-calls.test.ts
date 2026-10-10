import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Every id-only storage call in the runtime goes through `ownedBy`, which
 * attaches the record's owner key (see `OwnerScope`). A direct
 * `storage.updateRun(…)` compiles fine and works on a shared-table adapter,
 * but an adapter that routes by owner key can't serve it, and the end-to-end
 * test only catches the paths it drives. This catches the rest, however the
 * call is formatted.
 */
describe("id-only storage calls in the runtime", () => {
  it("all go through ownedBy", () => {
    const source = readFileSync(new URL("./runtime.ts", import.meta.url), "utf8");
    const helper = source.slice(source.indexOf("const ownedBy = "), source.indexOf("const withOwnerKey = "));
    const outside = source.replace(helper, "");
    const direct = [...outside.matchAll(/\bstorage\s*\.\s*(appendMessages|updateRun|getRun|heartbeatRun|reclaimRun|completeSchedule|noteScheduleFire)\b(\?\.)?\s*\(([^)]*)/g)]
      // The one call with no record in hand passes the principal instead.
      .filter((m) => !(m[1] === "getRun" && /\{\s*principal\s*\}/.test(m[3] ?? "")));
    expect(direct.map((m) => m[0].replace(/\s+/g, " ").slice(0, 60))).toEqual([]);
    expect(helper).toContain("storage.appendMessages(");
  });
});
