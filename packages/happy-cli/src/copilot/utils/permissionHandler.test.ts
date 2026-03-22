import { describe, it, expect } from 'vitest';
import { createCopilotPermissionHandler } from './permissionHandler';

describe('CopilotPermissionHandler', () => {
  describe('suggest mode', () => {
    const handler = createCopilotPermissionHandler('suggest');

    it('denies all tool calls (forces user approval)', async () => {
      const result = await handler.handleToolCall('tc1', 'bash', { command: 'ls' });
      expect(result.decision).toBe('denied');
    });

    it('denies file operations too', async () => {
      const result = await handler.handleToolCall('tc2', 'read', { path: 'file.ts' });
      expect(result.decision).toBe('denied');
    });
  });

  describe('auto-edit mode', () => {
    const handler = createCopilotPermissionHandler('auto-edit');

    it('approves file read operations', async () => {
      const result = await handler.handleToolCall('tc1', 'read', { path: 'file.ts' });
      expect(result.decision).toBe('approved');
    });

    it('approves file write operations', async () => {
      const result = await handler.handleToolCall('tc2', 'write', { path: 'file.ts' });
      expect(result.decision).toBe('approved');
    });

    it('approves file edit operations', async () => {
      const result = await handler.handleToolCall('tc3', 'edit', { path: 'file.ts' });
      expect(result.decision).toBe('approved');
    });

    it('approves grep/search operations', async () => {
      const result = await handler.handleToolCall('tc4', 'grep', { pattern: 'foo' });
      expect(result.decision).toBe('approved');
    });

    it('denies shell commands', async () => {
      const result = await handler.handleToolCall('tc5', 'bash', { command: 'npm test' });
      expect(result.decision).toBe('denied');
    });

    it('denies unknown tools', async () => {
      const result = await handler.handleToolCall('tc6', 'unknown-tool', {});
      expect(result.decision).toBe('denied');
    });
  });

  describe('yolo mode', () => {
    const handler = createCopilotPermissionHandler('yolo');

    it('approves normal shell commands', async () => {
      const result = await handler.handleToolCall('tc1', 'bash', { command: 'npm test' });
      expect(result.decision).toBe('approved_for_session');
    });

    it('approves file operations', async () => {
      const result = await handler.handleToolCall('tc2', 'edit', { path: 'file.ts' });
      expect(result.decision).toBe('approved_for_session');
    });

    it('denies rm -rf', async () => {
      const result = await handler.handleToolCall('tc3', 'bash', { command: 'rm -rf /' });
      expect(result.decision).toBe('denied');
    });

    it('denies git push --force', async () => {
      const result = await handler.handleToolCall('tc4', 'bash', { command: 'git push --force origin main' });
      expect(result.decision).toBe('denied');
    });

    it('denies sudo commands', async () => {
      const result = await handler.handleToolCall('tc5', 'bash', { command: 'sudo rm file' });
      expect(result.decision).toBe('denied');
    });

    it('denies git reset --hard', async () => {
      const result = await handler.handleToolCall('tc6', 'bash', { command: 'git reset --hard HEAD~5' });
      expect(result.decision).toBe('denied');
    });
  });
});
