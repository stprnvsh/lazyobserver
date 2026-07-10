export { paths, lazyHome, allDirs } from "./paths.js";
export {
  ConfigSchema,
  ProfileSchema,
  WorkspaceSchema,
  loadConfig,
  saveConfig,
  addProfile,
  removeProfile,
  addWorkspace,
  removeWorkspace,
  addRepoToWorkspace,
  setCurrentWorkspace,
  workspacesForRepo,
  normalizeRepoPath,
  expandTilde,
  type Config,
  type Profile,
  type Workspace,
} from "./config.js";
export {
  Embedder,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
} from "./embeddings.js";
export { Store, TABLES, type TableName } from "./store/index.js";
export { FTS_COLUMNS, TABLE_SCHEMAS } from "./store/schemas.js";
export { chunkText, type Chunk } from "./text.js";
export {
  smartSearch,
  localDate,
  type SmartSearchOptions,
  type SmartSearchResult,
} from "./store/search.js";
export {
  renderMemoryBlock,
  upsertMemoryBlock,
  repoToSlug,
  type ProjectedMemory,
} from "./projection.js";
export { buildSessionStartBrief } from "./brief.js";
export { getSecret, setSecret } from "./secrets.js";
