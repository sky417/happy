/**
 * Copilot CLI Detection Utilities
 *
 * Functions for detecting the Copilot CLI installation,
 * version, and authentication status.
 */

import { execSync } from 'child_process';
import { homedir } from 'os';

/**
 * Get a clean environment without local node_modules/.bin in PATH.
 * Prevents accidentally finding a local copilot instead of the global one.
 */
function getCleanEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  if (env.PATH) {
    env.PATH = env.PATH
      .split(process.platform === 'win32' ? ';' : ':')
      .filter(p => !p.includes('node_modules'))
      .join(process.platform === 'win32' ? ';' : ':');
  }
  return env;
}

/**
 * Find the global Copilot CLI path.
 *
 * @returns 'copilot' if found and working, or null if not installed
 */
export function findCopilotCliPath(): string | null {
  try {
    const cleanEnv = getCleanEnv();
    execSync('copilot --version', {
      encoding: 'utf8',
      cwd: homedir(),
      env: cleanEnv,
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return 'copilot';
  } catch {
    return null;
  }
}

/**
 * Get the version of the globally installed Copilot CLI.
 *
 * @returns Version string (e.g., '1.2.3') or null if not found
 */
export function getCopilotVersion(): string | null {
  try {
    const cleanEnv = getCleanEnv();
    const output = execSync('copilot --version', {
      encoding: 'utf8',
      cwd: homedir(),
      env: cleanEnv,
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const match = output.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Check if the user is authenticated with GitHub for Copilot access.
 * Checks via `gh auth status` command.
 *
 * @returns true if authenticated, false otherwise
 */
export function isCopilotAuthenticated(): boolean {
  try {
    const output = execSync('gh auth status', {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output.includes('Logged in') || output.includes('✓');
  } catch {
    // gh CLI not installed or not authenticated
    return false;
  }
}

/**
 * Check if the Copilot CLI supports ACP mode.
 *
 * @returns true if ACP is supported
 */
export function supportsCopilotAcp(): boolean {
  try {
    const cleanEnv = getCleanEnv();
    const output = execSync('copilot --help', {
      encoding: 'utf8',
      cwd: homedir(),
      env: cleanEnv,
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output.includes('acp');
  } catch {
    return false;
  }
}
