/**
 * Copilot Transport Handler
 *
 * Copilot CLI-specific implementation of TransportHandler.
 * Handles:
 * - Auth-aware init timeout (Copilot may need authentication on first start)
 * - Stdout filtering (removes non-JSON output that breaks JSON-RPC)
 * - Stderr parsing (detects rate limits, auth failures, model errors)
 * - Tool name patterns (change_title, save_memory, think)
 *
 * @module CopilotTransport
 */

import type {
  TransportHandler,
  ToolPattern,
  StderrContext,
  StderrResult,
  ToolNameContext,
} from '../TransportHandler';
import type { AgentMessage } from '../../core';
import { logger } from '@/ui/logger';

/**
 * Copilot-specific timeout values (in milliseconds)
 */
export const COPILOT_TIMEOUTS = {
  /** Copilot CLI may need authentication on first start */
  init: 60_000,
  /** Standard tool call timeout */
  toolCall: 120_000,
  /** Think tools are usually quick */
  think: 30_000,
  /** Idle detection after last message chunk */
  idle: 500,
} as const;

/**
 * Known tool name patterns for Copilot CLI.
 * Used to extract real tool names from toolCallId when Copilot sends "other".
 *
 * Each pattern includes:
 * - name: canonical tool name
 * - patterns: strings to match in toolCallId (case-insensitive)
 * - inputFields: optional fields that indicate this tool when present in input
 * - emptyInputDefault: if true, this tool is the default when input is empty
 */
interface ExtendedToolPattern extends ToolPattern {
  /** Fields in input that indicate this tool */
  inputFields?: string[];
  /** If true, this is the default tool when input is empty and toolName is "other" */
  emptyInputDefault?: boolean;
}

const COPILOT_TOOL_PATTERNS: ExtendedToolPattern[] = [
  {
    name: 'change_title',
    patterns: ['change_title', 'change-title', 'happy__change_title', 'mcp__happy__change_title'],
    inputFields: ['title'],
    emptyInputDefault: true,
  },
  {
    name: 'save_memory',
    patterns: ['save_memory', 'save-memory'],
    inputFields: ['memory', 'content'],
  },
  {
    name: 'think',
    patterns: ['think'],
    inputFields: ['thought', 'thinking'],
  },
];

/**
 * Copilot CLI transport handler.
 *
 * Handles all Copilot-specific quirks:
 * - Non-JSON output filtering from stdout
 * - Rate limit, auth failure, and model error detection in stderr
 * - Tool name extraction from toolCallId
 */
export class CopilotTransport implements TransportHandler {
  readonly agentName = 'copilot';

  /**
   * Copilot CLI may need authentication on first start
   */
  getInitTimeout(): number {
    return COPILOT_TIMEOUTS.init;
  }

  /**
   * Filter Copilot CLI output from stdout.
   *
   * Copilot CLI may output non-JSON content to stdout that breaks ACP
   * JSON-RPC parsing. We only keep valid JSON lines.
   */
  filterStdoutLine(line: string): string | null {
    const trimmed = line.trim();

    // Empty lines - skip
    if (!trimmed) {
      return null;
    }

    // Must start with { or [ to be valid JSON-RPC
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return null;
    }

    // Validate it's actually parseable JSON and is an object (not a primitive)
    // JSON-RPC messages are always objects, but numbers like "105887304" parse as valid JSON
    try {
      const parsed = JSON.parse(trimmed);
      // Must be an object or array (for batched requests), not a primitive
      if (typeof parsed !== 'object' || parsed === null) {
        return null;
      }
      return line;
    } catch {
      return null;
    }
  }

  /**
   * Handle Copilot CLI stderr output.
   *
   * Detects:
   * - Rate limit errors (429, "rate limit")
   * - Auth failures (unauthorized, authentication errors, subscription issues)
   * - Model not found (404)
   */
  handleStderr(text: string, _context: StderrContext): StderrResult {
    const trimmed = text.trim();
    if (!trimmed) {
      return { message: null, suppress: true };
    }

    const lower = trimmed.toLowerCase();

    // Rate limit error (429)
    if (
      lower.includes('429') ||
      lower.includes('rate limit') ||
      lower.includes('rate_limit')
    ) {
      const errorMessage: AgentMessage = {
        type: 'status',
        status: 'error',
        detail: 'Rate limited by Copilot API. Please wait a moment and try again.',
      };
      return { message: errorMessage };
    }

    // Auth failures
    if (
      lower.includes('unauthorized') ||
      lower.includes('authentication') ||
      lower.includes('not authenticated') ||
      lower.includes('subscription')
    ) {
      const errorMessage: AgentMessage = {
        type: 'status',
        status: 'error',
        detail: 'Copilot authentication failed. Run \'happy connect copilot\' to authenticate, or ensure your GitHub token is valid.',
      };
      return { message: errorMessage };
    }

    // Model not found (404)
    if (lower.includes('404') || lower.includes('not found')) {
      const errorMessage: AgentMessage = {
        type: 'status',
        status: 'error',
        detail: 'Copilot model not found. Check your model configuration.',
      };
      return { message: errorMessage };
    }

    return { message: null };
  }

  /**
   * Copilot-specific tool patterns
   */
  getToolPatterns(): ToolPattern[] {
    return COPILOT_TOOL_PATTERNS;
  }

  /**
   * Copilot doesn't have investigation tools like Gemini's codebase_investigator
   */
  isInvestigationTool(_toolCallId: string, _toolKind?: string): boolean {
    return false;
  }

  /**
   * Get timeout for a tool call based on tool kind
   */
  getToolCallTimeout(_toolCallId: string, toolKind?: string): number {
    if (toolKind === 'think') {
      return COPILOT_TIMEOUTS.think;
    }
    return COPILOT_TIMEOUTS.toolCall;
  }

  /**
   * Get idle detection timeout
   */
  getIdleTimeout(): number {
    return COPILOT_TIMEOUTS.idle;
  }

  /**
   * Extract tool name from toolCallId using Copilot patterns.
   *
   * Tool IDs often contain the tool name as a prefix (e.g., "change_title-1765385846663" -> "change_title")
   */
  extractToolNameFromId(toolCallId: string): string | null {
    const lowerId = toolCallId.toLowerCase();

    for (const toolPattern of COPILOT_TOOL_PATTERNS) {
      for (const pattern of toolPattern.patterns) {
        if (lowerId.includes(pattern.toLowerCase())) {
          return toolPattern.name;
        }
      }
    }

    return null;
  }

  /**
   * Check if input is effectively empty
   */
  private isEmptyInput(input: Record<string, unknown> | undefined | null): boolean {
    if (!input) return true;
    if (Array.isArray(input)) return input.length === 0;
    if (typeof input === 'object') return Object.keys(input).length === 0;
    return false;
  }

  /**
   * Determine the real tool name from various sources.
   *
   * When Copilot sends "other" or "Unknown tool", tries to determine the real name from:
   * 1. toolCallId patterns (most reliable - tool name often embedded in ID)
   * 2. Input field signatures (specific fields indicate specific tools)
   * 3. Empty input default (some tools like change_title have empty input)
   */
  determineToolName(
    toolName: string,
    toolCallId: string,
    input: Record<string, unknown>,
    _context: ToolNameContext
  ): string {
    // If tool name is already known, return it
    if (toolName !== 'other' && toolName !== 'Unknown tool') {
      return toolName;
    }

    // 1. Check toolCallId for known tool names (most reliable)
    const idToolName = this.extractToolNameFromId(toolCallId);
    if (idToolName) {
      return idToolName;
    }

    // 2. Check input fields for tool-specific signatures
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      const inputKeys = Object.keys(input);

      for (const toolPattern of COPILOT_TOOL_PATTERNS) {
        if (toolPattern.inputFields) {
          const hasMatchingField = toolPattern.inputFields.some((field) =>
            inputKeys.some((key) => key.toLowerCase() === field.toLowerCase())
          );
          if (hasMatchingField) {
            return toolPattern.name;
          }
        }
      }
    }

    // 3. For empty input, use the default tool (if configured)
    if (this.isEmptyInput(input) && toolName === 'other') {
      const defaultTool = COPILOT_TOOL_PATTERNS.find((p) => p.emptyInputDefault);
      if (defaultTool) {
        return defaultTool.name;
      }
    }

    // Return original tool name if we couldn't determine it
    if (toolName === 'other' || toolName === 'Unknown tool') {
      const inputKeys = input && typeof input === 'object' ? Object.keys(input) : [];
      logger.debug(
        `[CopilotTransport] Unknown tool pattern - toolCallId: "${toolCallId}", ` +
        `toolName: "${toolName}", inputKeys: [${inputKeys.join(', ')}]. ` +
        `Consider adding a new pattern to COPILOT_TOOL_PATTERNS if this tool appears frequently.`
      );
    }

    return toolName;
  }
}

/**
 * Singleton instance for convenience
 */
export const copilotTransport = new CopilotTransport();
