/**
 * Copilot Constants
 *
 * Centralized constants for GitHub Copilot CLI integration including
 * environment variable names and default values.
 */

import { trimIdent } from '@/utils/trimIdent';

/** Environment variable name for GitHub token */
export const GITHUB_TOKEN_ENV = 'GITHUB_TOKEN';

/** Alternative environment variable name for GitHub token */
export const GH_TOKEN_ENV = 'GH_TOKEN';

/** Environment variable name for Copilot model selection */
export const COPILOT_MODEL_ENV = 'COPILOT_MODEL';

/** Default Copilot model (let Copilot CLI choose) */
export const DEFAULT_COPILOT_MODEL = 'default';

/**
 * Instruction for changing chat title
 * Used in system prompts to instruct agents to call change_title function
 */
export const CHANGE_TITLE_INSTRUCTION = trimIdent(
  `Based on this message, call functions.happy__change_title to change chat session title that would represent the current task. If chat idea would change dramatically - call this function again to update the title.`
);
