import { loader } from "fumadocs-core/source";
import { docs } from "@/.source/server";

/** The docs tree, rooted at /docs. */
export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});
