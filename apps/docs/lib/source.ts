import { loader } from "fumadocs-core/source";
import { docs } from "@/.source/server";

/** Where the docs tree is mounted. Exported so URL→slug logic can't drift from it. */
export const DOCS_BASE_URL = "/docs";

/** The docs tree, rooted at {@link DOCS_BASE_URL}. */
export const source = loader({
  baseUrl: DOCS_BASE_URL,
  source: docs.toFumadocsSource(),
});
