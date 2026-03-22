/**
 * Copilot ACP Backend - GitHub Copilot CLI agent via ACP
 *
 * This module provides a factory function for creating a Copilot backend
 * that communicates using the Agent Client Protocol (ACP).
 *
 * Copilot CLI uses the 'copilot acp --stdio' command for ACP mode.
 */

import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from '../acp/AcpBackend';
import type { AgentBackend, McpServerConfig, AgentFactoryOptions } from '../core';
import { agentRegistry } from '../core';
import { copilotTransport } from '../transport';
import { logger } from '@/ui/logger';

const GITHUB_TOKEN_ENV = 'GITHUB_TOKEN';
const GH_TOKEN_ENV = 'GH_TOKEN';
const COPILOT_MODEL_ENV = 'COPILOT_MODEL';
const DEFAULT_COPILOT_MODEL = 'default';

/**
 * Options for creating a Copilot ACP backend
 */
export interface CopilotBackendOptions extends AgentFactoryOptions {
  /** GitHub token from Happy connect flow */
  githubToken?: string;

  /** Model to use. If undefined or null, let Copilot CLI choose.
   *  Can be overridden via COPILOT_MODEL env var. */
  model?: string | null;

  /** MCP servers to make available to the agent */
  mcpServers?: Record<string, McpServerConfig>;

  /** Optional permission handler for tool approval */
  permissionHandler?: AcpPermissionHandler;
}

/**
 * Result of creating a Copilot backend
 */
export interface CopilotBackendResult {
  /** The created AgentBackend instance */
  backend: AgentBackend;
  /** The resolved model that will be used */
  model: string;
  /** Source of the model selection for logging */
  modelSource: 'explicit' | 'env-var' | 'default';
}

/**
 * Create a Copilot backend using ACP.
 *
 * The Copilot CLI must be installed and available in PATH.
 * Uses 'copilot acp --stdio' to enable ACP mode.
 *
 * @param options - Configuration options
 * @returns CopilotBackendResult with backend and resolved model
 */
export function createCopilotBackend(options: CopilotBackendOptions): CopilotBackendResult {

  // Resolve GitHub token from multiple sources (in priority order):
  // 1. options.githubToken (from 'happy connect copilot')
  // 2. GITHUB_TOKEN environment variable
  // 3. GH_TOKEN environment variable
  const githubToken = options.githubToken
    || process.env[GITHUB_TOKEN_ENV]
    || process.env[GH_TOKEN_ENV];

  if (!githubToken) {
    logger.warn(`[Copilot] No GitHub token found. Run 'happy connect copilot' to authenticate, or set ${GITHUB_TOKEN_ENV} environment variable.`);
  }

  // Resolve model
  // Priority: options.model (if provided) > env var > default
  let model: string;
  let modelSource: 'explicit' | 'env-var' | 'default';

  if (options.model !== undefined && options.model !== null) {
    model = options.model;
    modelSource = 'explicit';
  } else if (process.env[COPILOT_MODEL_ENV]) {
    model = process.env[COPILOT_MODEL_ENV]!;
    modelSource = 'env-var';
  } else {
    model = DEFAULT_COPILOT_MODEL;
    modelSource = 'default';
  }

  const copilotCommand = 'copilot';
  const copilotArgs = ['acp', '--stdio'];

  const backendOptions: AcpBackendOptions = {
    agentName: 'copilot',
    cwd: options.cwd,
    command: copilotCommand,
    args: copilotArgs,
    env: {
      ...options.env,
      ...(githubToken ? { [GITHUB_TOKEN_ENV]: githubToken } : {}),
      ...(model !== DEFAULT_COPILOT_MODEL ? { [COPILOT_MODEL_ENV]: model } : {}),
    },
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: copilotTransport,
    hasChangeTitleInstruction: (prompt: string) => {
      const lower = prompt.toLowerCase();
      return lower.includes('change_title') ||
             lower.includes('change title') ||
             lower.includes('set title') ||
             lower.includes('mcp__happy__change_title');
    },
  };

  logger.debug('[Copilot] Creating ACP SDK backend with options:', {
    cwd: backendOptions.cwd,
    command: backendOptions.command,
    args: backendOptions.args,
    hasGithubToken: !!githubToken,
    model: model,
    modelSource: modelSource,
    mcpServerCount: options.mcpServers ? Object.keys(options.mcpServers).length : 0,
  });

  return {
    backend: new AcpBackend(backendOptions),
    model,
    modelSource,
  };
}

/**
 * Register Copilot backend with the global agent registry.
 *
 * This function should be called during application initialization
 * to make the Copilot agent available for use.
 */
export function registerCopilotAgent(): void {
  agentRegistry.register('copilot', (opts) => createCopilotBackend(opts).backend);
  logger.debug('[Copilot] Registered with agent registry');
}
