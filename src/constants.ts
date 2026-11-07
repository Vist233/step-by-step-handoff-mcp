export const STORE_DIR_NAME = "step-by-step-handoff-mcp";
export const MANIFEST_FILE_NAME = "handoff.json";
export const WORKSPACE_DIR_NAME = ".exchange";
export const LOCK_FILE_NAME = "exchange.lock";

export const MAX_FILE_COUNT = 500;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
export const COMMAND_OUTPUT_LIMIT_BYTES = 1024 * 1024;
export const OUTPUT_TAIL_CHARS = 2000;

export const DEFAULT_SEARCH_LIMIT = 20;

/** Same limits as the Agent Skills spec: name 64 chars, description 1024 chars. */
export const NAME_MAX_CHARS = 64;
export const DESCRIPTION_MAX_CHARS = 1024;
export const MAX_TAGS = 10;

/** Search output budget, modelled on how skill listings are capped (about 250 chars per entry, about 8000 in total). */
export const SEARCH_DESCRIPTION_CHARS = 250;
export const SEARCH_RESPONSE_BUDGET_CHARS = 8000;
export const SEARCH_MAX_LIMIT = 100;
export const REFINE_TAG_COUNT = 8;
export const REFINE_SCAN_ROWS = 5000;

export const PEEK_MAX_CHARS = 20000;
export const BINARY_SNIFF_BYTES = 8000;
