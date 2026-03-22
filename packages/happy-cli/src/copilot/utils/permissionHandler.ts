/**
 * Copilot Permission Handler
 *
 * Handles tool permission requests for Copilot ACP sessions.
 * Implements AcpPermissionHandler with three permission modes:
 * - suggest:    Always ask the user (most restrictive, default)
 * - auto-edit:  Auto-approve file operations, ask for shell commands
 * - yolo:       Auto-approve everything except dangerous commands
 */

import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { CopilotPermissionMode } from '@/copilot/types';

const DANGEROUS_COMMANDS = [
    'rm -rf', 'rm -r', 'rmdir',
    'git push --force', 'git push -f',
    'git reset --hard',
    'sudo', 'chmod 777',
    'format', 'mkfs',
    'dd if=',
    '> /dev/',
];

const FILE_TOOL_PATTERNS = [
    'read', 'write', 'edit', 'create', 'view',
    'list', 'search', 'grep', 'glob',
    'fs-read', 'fs-write', 'fs-edit',
];

function isFileTool(toolName: string): boolean {
    const lower = toolName.toLowerCase();
    return FILE_TOOL_PATTERNS.some(pattern => lower.includes(pattern));
}

function containsDangerousCommand(input: Record<string, unknown>): boolean {
    const command = String(input.command || input.cmd || input.script || '');
    return DANGEROUS_COMMANDS.some(dc => command.includes(dc));
}

class CopilotPermissionHandler implements AcpPermissionHandler {
    private mode: CopilotPermissionMode;

    constructor(mode: CopilotPermissionMode) {
        this.mode = mode;
    }

    async handleToolCall(
        callId: string,
        toolName: string,
        input: Record<string, unknown>
    ): Promise<{ decision: 'approved' | 'approved_for_session' | 'denied' | 'abort' }> {
        switch (this.mode) {
            case 'suggest':
                // Most restrictive: always defer to the user
                return { decision: 'denied' };

            case 'auto-edit':
                // Auto-approve file reads/writes/edits, ask for everything else
                if (isFileTool(toolName)) {
                    return { decision: 'approved' };
                }
                return { decision: 'denied' };

            case 'yolo':
                // Auto-approve everything except dangerous commands
                if (containsDangerousCommand(input)) {
                    return { decision: 'denied' };
                }
                return { decision: 'approved_for_session' };

            default:
                return { decision: 'denied' };
        }
    }
}

export function createCopilotPermissionHandler(
    mode: CopilotPermissionMode
): AcpPermissionHandler {
    return new CopilotPermissionHandler(mode);
}
