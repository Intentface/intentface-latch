export { createKnowledge } from "./knowledge.js";
export type {
  GrepHit,
  Knowledge,
  KnowledgeAccess,
  KnowledgeConfig,
  KnowledgeEntry,
  KnowledgeFile,
  KnowledgeView,
  Role,
  SearchHit,
  SpaceKind,
} from "./knowledge.js";
export { knowledgeTools, type KnowledgeToolName, type KnowledgeToolsOptions } from "./tools.js";
export { fromPGlite, fromPgPool, type KnowledgeDb, type SqlClient } from "./db.js";
export { migrate, MIGRATIONS } from "./schema.js";
export { KnowledgeError, isKnowledgeError, type KnowledgeErrorCode } from "./errors.js";
export { frontmatterDescription } from "./frontmatter.js";
