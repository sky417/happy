import { describe, it, expect } from 'vitest';
import { CopilotTransport, COPILOT_TIMEOUTS } from './CopilotTransport';

describe('CopilotTransport', () => {
  const transport = new CopilotTransport();

  describe('getInitTimeout', () => {
    it('returns 60 second init timeout', () => {
      expect(transport.getInitTimeout()).toBe(60_000);
    });
  });

  describe('filterStdoutLine', () => {
    it('keeps valid JSON object lines', () => {
      expect(transport.filterStdoutLine('{"jsonrpc":"2.0","id":1}')).not.toBeNull();
    });

    it('keeps valid JSON array lines', () => {
      expect(transport.filterStdoutLine('[{"id":1}]')).not.toBeNull();
    });

    it('drops empty lines', () => {
      expect(transport.filterStdoutLine('')).toBeNull();
      expect(transport.filterStdoutLine('   ')).toBeNull();
    });

    it('drops non-JSON debug output', () => {
      expect(transport.filterStdoutLine('Copilot CLI v1.2.3')).toBeNull();
      expect(transport.filterStdoutLine('Loading extensions...')).toBeNull();
      expect(transport.filterStdoutLine('WARNING: something')).toBeNull();
    });

    it('drops plain numbers that parse as JSON', () => {
      expect(transport.filterStdoutLine('12345')).toBeNull();
    });

    it('drops malformed JSON', () => {
      expect(transport.filterStdoutLine('{not json}')).toBeNull();
    });
  });

  describe('handleStderr', () => {
    const context = { activeToolCalls: new Set<string>(), hasActiveInvestigation: false };

    it('detects rate limit errors', () => {
      const result = transport.handleStderr('Error: 429 Too Many Requests', context);
      expect(result.message).not.toBeNull();
      expect(result.message!.type).toBe('status');
    });

    it('detects auth failures', () => {
      const result = transport.handleStderr('Error: unauthorized', context);
      expect(result.message).not.toBeNull();
      expect(result.message!.type).toBe('status');
    });

    it('detects subscription issues', () => {
      const result = transport.handleStderr('No active subscription found', context);
      expect(result.message).not.toBeNull();
    });

    it('returns null message for normal stderr', () => {
      const result = transport.handleStderr('some debug info', context);
      expect(result.message).toBeNull();
    });

    it('suppresses empty stderr', () => {
      const result = transport.handleStderr('', context);
      expect(result.message).toBeNull();
      expect(result.suppress).toBe(true);
    });
  });

  describe('determineToolName', () => {
    const context = { recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 };

    it('returns known tool names as-is', () => {
      expect(transport.determineToolName('bash', 'tc1', {}, context)).toBe('bash');
    });

    it('extracts tool name from toolCallId', () => {
      expect(transport.determineToolName('other', 'change_title-12345', {}, context)).toBe('change_title');
      expect(transport.determineToolName('other', 'save_memory-99', {}, context)).toBe('save_memory');
    });

    it('detects tool from input fields', () => {
      expect(transport.determineToolName('other', 'unknown-1', { title: 'My Title' }, context)).toBe('change_title');
      expect(transport.determineToolName('other', 'unknown-2', { thought: 'thinking...' }, context)).toBe('think');
    });

    it('defaults to change_title for empty input', () => {
      expect(transport.determineToolName('other', 'unknown-3', {}, context)).toBe('change_title');
    });
  });

  describe('isInvestigationTool', () => {
    it('always returns false', () => {
      expect(transport.isInvestigationTool('any-tool')).toBe(false);
    });
  });

  describe('getToolCallTimeout', () => {
    it('returns think timeout for think tools', () => {
      expect(transport.getToolCallTimeout('tc1', 'think')).toBe(COPILOT_TIMEOUTS.think);
    });

    it('returns standard timeout for other tools', () => {
      expect(transport.getToolCallTimeout('tc1', 'bash')).toBe(COPILOT_TIMEOUTS.toolCall);
    });
  });
});
