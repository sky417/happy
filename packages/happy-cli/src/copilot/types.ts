/**
 * Copilot CLI Types
 *
 * Type definitions for GitHub Copilot CLI integration.
 */

import type { PermissionMode } from '@/api/types';

/** Copilot permission modes matching Copilot CLI's native approval model */
export type CopilotPermissionMode = 'suggest' | 'auto-edit' | 'yolo';

/** Mode configuration for Copilot message queue hashing */
export interface CopilotMode {
  permissionMode: PermissionMode;
  model?: string;
  originalUserMessage?: string;
}

/** Copilot model configuration */
export interface CopilotModelConfig {
  /** Model code/identifier */
  code: string;
  /** Human-readable model name */
  name: string;
}

/** Configuration for running Copilot */
export interface CopilotConfig {
  /** GitHub token for authentication */
  githubToken?: string;
  /** Model to use (or 'default' for Copilot's default) */
  model?: string | null;
  /** Current permission mode */
  permissionMode?: CopilotPermissionMode;
}

/** Result of Copilot CLI version detection */
export interface CopilotVersionInfo {
  /** Full version string */
  version: string;
  /** Whether ACP mode is available */
  supportsAcp: boolean;
}
