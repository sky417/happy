/**
 * Copilot CLI Entry Point
 *
 * This module provides the main entry point for running the GitHub Copilot
 * agent through Happy CLI. It manages the agent lifecycle, session state, and
 * communication with the Happy server and mobile app.
 *
 * Modeled on the Gemini entry point (runGemini.ts), reuses GeminiDisplay with agentName='Copilot'.
 */

import { render } from 'ink';
import React from 'react';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { Credentials, readSettings } from '@/persistence';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { initialMachineMetadata } from '@/daemon/run';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { projectPath } from '@/projectPath';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { stopCaffeinate } from '@/utils/caffeinate';
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import type { ApiSessionClient } from '@/api/apiSession';

import { createCopilotBackend } from '@/agent/factories/copilot';
import type { AgentBackend, AgentMessage } from '@/agent';
import { GeminiDisplay } from '@/ui/ink/GeminiDisplay';
import { createCopilotPermissionHandler } from '@/copilot/utils/permissionHandler';
import type { CopilotMode, CopilotPermissionMode } from '@/copilot/types';
import type { PermissionMode } from '@/api/types';
import { COPILOT_MODEL_ENV, DEFAULT_COPILOT_MODEL, CHANGE_TITLE_INSTRUCTION } from '@/copilot/constants';

// ACP provider identifier for session messages
// Use 'copilot' when the app has been deployed with the new provider enum
// Use 'opencode' as fallback for production app compatibility
const ACP_PROVIDER = 'copilot' as const;

/**
 * Map Happy's PermissionMode to Copilot's CopilotPermissionMode.
 */
function mapToCopilotPermission(mode: PermissionMode): CopilotPermissionMode {
  switch (mode) {
    case 'yolo':
    case 'bypassPermissions': return 'yolo';
    case 'safe-yolo':
    case 'acceptEdits': return 'auto-edit';
    case 'read-only':
    case 'default': return 'suggest';
    default: return 'suggest';
  }
}

/**
 * Main entry point for the copilot command with ink UI
 */
export async function runCopilot(opts: {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
}): Promise<void> {
  //
  // Define session
  //

  const sessionTag = randomUUID();

  // Set backend for offline warnings (before any API calls)
  connectionState.setBackend('Copilot');

  const api = await ApiClient.create(opts.credentials);

  //
  // Machine
  //

  const settings = await readSettings();
  const machineId = settings?.machineId;
  const sandboxConfig = settings?.sandboxConfig;
  if (!machineId) {
    console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/slopus/happy-cli/issues`);
    process.exit(1);
  }
  logger.debug(`Using machineId: ${machineId}`);
  await api.getOrCreateMachine({
    machineId,
    metadata: initialMachineMetadata
  });

  //
  // Fetch GitHub token from Happy cloud (via 'happy connect copilot')
  //
  let githubToken: string | undefined = undefined;
  try {
    const vendorToken = await api.getVendorToken('github');
    if (vendorToken?.oauth?.access_token) {
      githubToken = vendorToken.oauth.access_token;
      logger.debug('[Copilot] Using GitHub token from Happy cloud');
    }
  } catch (error) {
    logger.debug('[Copilot] Failed to fetch cloud token:', error);
  }

  //
  // Create session
  //

  const { state, metadata } = createSessionMetadata({
    flavor: 'copilot',
    machineId,
    startedBy: opts.startedBy,
    sandbox: sandboxConfig,
  });
  const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });

  // Handle server unreachable case - create offline stub with hot reconnection
  let session: ApiSessionClient;

  // Session swap synchronization to prevent race conditions during message processing
  // When a swap is requested during processing, it's queued and applied after the current cycle
  let isProcessingMessage = false;
  let pendingSessionSwap: ApiSessionClient | null = null;

  /**
   * Apply a pending session swap. Called between message processing cycles.
   */
  const applyPendingSessionSwap = () => {
    if (pendingSessionSwap) {
      logger.debug('[copilot] Applying pending session swap');
      session = pendingSessionSwap;
      pendingSessionSwap = null;
    }
  };

  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    onSessionSwap: (newSession) => {
      if (isProcessingMessage) {
        logger.debug('[copilot] Session swap requested during message processing - queueing');
        pendingSessionSwap = newSession;
      } else {
        session = newSession;
      }
    }
  });
  session = initialSession;

  // Report to daemon (only if we have a real session)
  if (response) {
    try {
      logger.debug(`[START] Reporting session ${response.id} to daemon`);
      const result = await notifyDaemonSessionStarted(response.id, metadata);
      if (result.error) {
        logger.debug(`[START] Failed to report to daemon (may not be running):`, result.error);
      } else {
        logger.debug(`[START] Reported session ${response.id} to daemon`);
      }
    } catch (error) {
      logger.debug('[START] Failed to report to daemon (may not be running):', error);
    }
  }

  const messageQueue = new MessageQueue2<CopilotMode>((mode) => hashObject({
    permissionMode: mode.permissionMode,
    model: mode.model,
  }));

  // Track current overrides to apply per message
  let currentPermissionMode: PermissionMode | undefined = undefined;
  let currentModel: string | undefined = undefined;
  // Track current copilot permission mode for handler creation
  let copilotPermMode: CopilotPermissionMode = 'suggest';

  session.onUserMessage((message) => {
    // Resolve permission mode (validate)
    let messagePermissionMode = currentPermissionMode;
    if (message.meta?.permissionMode) {
      const validModes: PermissionMode[] = ['default', 'read-only', 'safe-yolo', 'yolo'];
      if (validModes.includes(message.meta.permissionMode as PermissionMode)) {
        messagePermissionMode = message.meta.permissionMode as PermissionMode;
        currentPermissionMode = messagePermissionMode;
        updatePermissionMode(messagePermissionMode);
        logger.debug(`[Copilot] Permission mode updated from user message to: ${currentPermissionMode}`);
      } else {
        logger.debug(`[Copilot] Invalid permission mode received: ${message.meta.permissionMode}`);
      }
    } else {
      logger.debug(`[Copilot] User message received with no permission mode override, using current: ${currentPermissionMode ?? 'default (effective)'}`);
    }

    // Initialize permission mode if not set yet
    if (currentPermissionMode === undefined) {
      currentPermissionMode = 'default';
      updatePermissionMode('default');
    }

    // Resolve model; explicit null resets to default (undefined)
    let messageModel = currentModel;
    if (message.meta?.hasOwnProperty('model')) {
      if (message.meta.model === null) {
        messageModel = undefined;
        currentModel = undefined;
      } else if (message.meta.model) {
        const previousModel = currentModel;
        messageModel = message.meta.model;
        currentModel = messageModel;
        if (previousModel !== messageModel) {
          updateDisplayedModel(messageModel);
          messageBuffer.addMessage(`Model changed to: ${messageModel}`, 'system');
          logger.debug(`[Copilot] Model changed from ${previousModel} to ${messageModel}`);
        }
      }
    }

    // Build the full prompt with appendSystemPrompt if provided
    // Only include system prompt for the first message
    const originalUserMessage = message.content.text;
    let fullPrompt = originalUserMessage;
    if (isFirstMessage && message.meta?.appendSystemPrompt) {
      fullPrompt = message.meta.appendSystemPrompt + '\n\n' + originalUserMessage + '\n\n' + CHANGE_TITLE_INSTRUCTION;
      isFirstMessage = false;
    }

    const mode: CopilotMode = {
      permissionMode: messagePermissionMode || 'default',
      model: messageModel,
      originalUserMessage,
    };
    messageQueue.push(fullPrompt, mode);
  });

  let thinking = false;
  session.keepAlive(thinking, 'remote');
  const keepAliveInterval = setInterval(() => {
    session.keepAlive(thinking, 'remote');
  }, 2000);

  // Track if this is the first message to include system prompt only once
  let isFirstMessage = true;

  const sendReady = () => {
    session.sendSessionEvent({ type: 'ready' });
    try {
      api.push().sendToAllDevices(
        "It's ready!",
        'Copilot is waiting for your command',
        { sessionId: session.sessionId }
      );
    } catch (pushError) {
      logger.debug('[Copilot] Failed to send ready push', pushError);
    }
  };

  /**
   * Check if we can emit ready event.
   * Returns true when ready event was emitted.
   */
  const emitReadyIfIdle = (): boolean => {
    if (shouldExit) return false;
    if (thinking) return false;
    if (isResponseInProgress) return false;
    if (messageQueue.size() > 0) return false;

    sendReady();
    return true;
  };

  //
  // Abort handling
  //

  let abortController = new AbortController();
  let shouldExit = false;
  let copilotBackend: AgentBackend | null = null;
  let acpSessionId: string | null = null;
  let wasSessionCreated = false;

  async function handleAbort() {
    logger.debug('[Copilot] Abort requested - stopping current task');

    session.sendAgentMessage(ACP_PROVIDER, {
      type: 'turn_aborted',
      id: randomUUID(),
    });

    try {
      abortController.abort();
      messageQueue.reset();
      if (copilotBackend && acpSessionId) {
        await copilotBackend.cancel(acpSessionId);
      }
      logger.debug('[Copilot] Abort completed - session remains active');
    } catch (error) {
      logger.debug('[Copilot] Error during abort:', error);
    } finally {
      abortController = new AbortController();
    }
  }

  const handleKillSession = async () => {
    logger.debug('[Copilot] Kill session requested - terminating process');
    await handleAbort();
    logger.debug('[Copilot] Abort completed, proceeding with termination');

    try {
      if (session) {
        session.updateMetadata((currentMetadata) => ({
          ...currentMetadata,
          lifecycleState: 'archived',
          lifecycleStateSince: Date.now(),
          archivedBy: 'cli',
          archiveReason: 'User terminated'
        }));

        session.sendSessionDeath();
        await session.flush();
        await session.close();
      }

      stopCaffeinate();
      happyServer.stop();

      if (copilotBackend) {
        await copilotBackend.dispose();
      }

      logger.debug('[Copilot] Session termination complete, exiting');
      process.exit(0);
    } catch (error) {
      logger.debug('[Copilot] Error during session termination:', error);
      process.exit(1);
    }
  };

  session.rpcHandlerManager.registerHandler('abort', handleAbort);
  registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

  //
  // Initialize Ink UI
  //

  const messageBuffer = new MessageBuffer();
  const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
  let inkInstance: ReturnType<typeof render> | null = null;

  // Track current model for UI display
  let displayedModel: string | undefined = process.env[COPILOT_MODEL_ENV] || undefined;

  const updateDisplayedModel = (model: string | undefined) => {
    if (model === undefined) return;
    const oldModel = displayedModel;
    displayedModel = model;
    if (hasTTY && oldModel !== model) {
      logger.debug(`[copilot] Adding model update message to buffer: [MODEL:${model}]`);
      messageBuffer.addMessage(`[MODEL:${model}]`, 'system');
    }
  };

  if (hasTTY) {
    console.clear();
    const DisplayComponent = () => {
      const currentModelValue = displayedModel || DEFAULT_COPILOT_MODEL;
      return React.createElement(GeminiDisplay, {
        messageBuffer,
        logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
        currentModel: currentModelValue,
        agentName: 'Copilot',
        onExit: async () => {
          logger.debug('[copilot]: Exiting agent via Ctrl-C');
          shouldExit = true;
          await handleAbort();
        }
      });
    };

    inkInstance = render(React.createElement(DisplayComponent), {
      exitOnCtrlC: false,
      patchConsole: false
    });

    const initialModelName = displayedModel || DEFAULT_COPILOT_MODEL;
    messageBuffer.addMessage(`[MODEL:${initialModelName}]`, 'system');
  }

  if (hasTTY) {
    process.stdin.resume();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.setEncoding('utf8');
  }

  //
  // Start Happy MCP server and create Copilot backend
  //

  const happyServer = await startHappyServer(session);
  const bridgeCommand = join(projectPath(), 'bin', 'happy-mcp.mjs');
  const mcpServers = {
    happy: {
      command: bridgeCommand,
      args: ['--url', happyServer.url]
    }
  };

  // Update permission mode mapping
  const updatePermissionMode = (mode: PermissionMode) => {
    copilotPermMode = mapToCopilotPermission(mode);
    logger.debug(`[Copilot] Permission mode mapped: ${mode} → ${copilotPermMode}`);
  };

  // Accumulate Copilot response text for sending complete message to mobile
  let accumulatedResponse = '';
  let isResponseInProgress = false;
  let hadToolCallInTurn = false;
  let pendingChangeTitle = false;
  let changeTitleCompleted = false;
  let taskStartedSent = false;

  /**
   * Set up message handler for Copilot backend.
   * This function is called when backend is created or recreated.
   */
  function setupCopilotMessageHandler(backend: AgentBackend): void {
    backend.onMessage((msg: AgentMessage) => {

    switch (msg.type) {
      case 'model-output':
        if (msg.textDelta) {
          if (!isResponseInProgress) {
            messageBuffer.removeLastMessage('system');
            messageBuffer.addMessage(msg.textDelta, 'assistant');
            isResponseInProgress = true;
            logger.debug(`[copilot] Started new response, first chunk length: ${msg.textDelta.length}`);
          } else {
            messageBuffer.updateLastMessage(msg.textDelta, 'assistant');
          }
          accumulatedResponse += msg.textDelta;
          // Stream text to mobile app immediately
          session.sendAgentMessage(ACP_PROVIDER, {
            type: 'message',
            message: msg.textDelta,
          });
        }
        break;

      case 'status': {
        const statusDetail = msg.detail
          ? (typeof msg.detail === 'object' ? JSON.stringify(msg.detail) : String(msg.detail))
          : '';
        logger.debug(`[copilot] Status changed: ${msg.status}${statusDetail ? ` - ${statusDetail}` : ''}`);

        if (msg.status === 'error') {
          logger.debug(`[copilot] ⚠️ Error status received: ${statusDetail || 'Unknown error'}`);

          session.sendAgentMessage(ACP_PROVIDER, {
            type: 'turn_aborted',
            id: randomUUID(),
          });
        }

        if (msg.status === 'running') {
          thinking = true;
          session.keepAlive(thinking, 'remote');

          if (!taskStartedSent) {
            session.sendAgentMessage(ACP_PROVIDER, {
              type: 'task_started',
              id: randomUUID(),
            });
            taskStartedSent = true;
          }

          messageBuffer.addMessage('Thinking...', 'system');
        } else if (msg.status === 'idle' || msg.status === 'stopped') {
          // Don't change thinking state here - handled in finally block
        } else if (msg.status === 'error') {
          thinking = false;
          session.keepAlive(thinking, 'remote');
          accumulatedResponse = '';
          isResponseInProgress = false;

          let errorMessage = 'Unknown error';
          if (msg.detail) {
            if (typeof msg.detail === 'object') {
              const detailObj = msg.detail as Record<string, unknown>;
              errorMessage = (detailObj.message as string) ||
                           (detailObj.details as string) ||
                           JSON.stringify(detailObj);
            } else {
              errorMessage = String(msg.detail);
            }
          }

          if (errorMessage.includes('auth') || errorMessage.includes('token')) {
            errorMessage += '\nTry: happy connect copilot';
          }

          messageBuffer.addMessage(`Error: ${errorMessage}`, 'status');
          session.sendAgentMessage(ACP_PROVIDER, {
            type: 'message',
            message: `Error: ${errorMessage}`,
          });
        }
        break;
      }

      case 'tool-call': {
        hadToolCallInTurn = true;
        const toolArgs = msg.args ? JSON.stringify(msg.args).substring(0, 100) : '';
        logger.debug(`[copilot] 🔧 Tool call received: ${msg.toolName} (${msg.callId})`);
        messageBuffer.addMessage(`Executing: ${msg.toolName}${toolArgs ? ` ${toolArgs}${toolArgs.length >= 100 ? '...' : ''}` : ''}`, 'tool');
        session.sendAgentMessage(ACP_PROVIDER, {
          type: 'tool-call',
          name: msg.toolName,
          callId: msg.callId,
          input: msg.args,
          id: randomUUID(),
        });
        break;
      }

      case 'tool-result': {
        if (msg.toolName === 'change_title' ||
            msg.callId?.includes('change_title') ||
            msg.toolName === 'happy__change_title') {
          changeTitleCompleted = true;
          logger.debug('[copilot] change_title completed');
        }

        const isError = msg.result && typeof msg.result === 'object' && 'error' in msg.result;
        const resultText = typeof msg.result === 'string'
          ? msg.result.substring(0, 200)
          : JSON.stringify(msg.result).substring(0, 200);

        logger.debug(`[copilot] ${isError ? '❌' : '✅'} Tool result: ${msg.toolName} (${msg.callId})`);

        if (isError) {
          const errorMsg = (msg.result as any).error || 'Tool call failed';
          messageBuffer.addMessage(`Error: ${errorMsg}`, 'status');
        } else {
          messageBuffer.addMessage(`Result: ${resultText}`, 'result');
        }

        session.sendAgentMessage(ACP_PROVIDER, {
          type: 'tool-result',
          callId: msg.callId,
          output: msg.result,
          id: randomUUID(),
        });
        break;
      }

      case 'fs-edit':
        messageBuffer.addMessage(`File edit: ${msg.description}`, 'tool');
        session.sendAgentMessage(ACP_PROVIDER, {
          type: 'file-edit',
          description: msg.description,
          diff: msg.diff,
          filePath: msg.path || 'unknown',
          id: randomUUID(),
        });
        break;

      case 'terminal-output':
        messageBuffer.addMessage(msg.data, 'result');
        session.sendAgentMessage(ACP_PROVIDER, {
          type: 'terminal-output',
          data: msg.data,
          callId: (msg as any).callId || randomUUID(),
        });
        break;

      case 'permission-request': {
        const payload = (msg as any).payload || {};
        session.sendAgentMessage(ACP_PROVIDER, {
          type: 'permission-request',
          permissionId: msg.id,
          toolName: payload.toolName || (msg as any).reason || 'unknown',
          description: (msg as any).reason || payload.toolName || '',
          options: payload,
        });
        break;
      }

      case 'exec-approval-request': {
        const execApprovalMsg = msg as any;
        const eaCallId = execApprovalMsg.call_id || execApprovalMsg.callId || randomUUID();
        logger.debug(`[copilot] Exec approval request received: ${eaCallId}`);
        messageBuffer.addMessage(`Exec approval requested: ${eaCallId}`, 'tool');
        const { call_id: _cid, type: _t, ...inputs } = execApprovalMsg;
        session.sendAgentMessage(ACP_PROVIDER, {
          type: 'tool-call',
          name: 'CopilotBash',
          callId: eaCallId,
          input: inputs,
          id: randomUUID(),
        });
        break;
      }

      case 'patch-apply-begin': {
        const patchBeginMsg = msg as any;
        const patchCallId = patchBeginMsg.call_id || patchBeginMsg.callId || randomUUID();
        const changes = patchBeginMsg.changes;
        const changeCount = changes ? Object.keys(changes).length : 0;
        const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
        messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');
        logger.debug(`[copilot] Patch apply begin: ${patchCallId}, files: ${changeCount}`);
        session.sendAgentMessage(ACP_PROVIDER, {
          type: 'tool-call',
          name: 'CopilotPatch',
          callId: patchCallId,
          input: {
            auto_approved: patchBeginMsg.auto_approved,
            changes
          },
          id: randomUUID(),
        });
        break;
      }

      case 'patch-apply-end': {
        const patchEndMsg = msg as any;
        const peCallId = patchEndMsg.call_id || patchEndMsg.callId || randomUUID();
        if (patchEndMsg.success) {
          const message = patchEndMsg.stdout || 'Files modified successfully';
          messageBuffer.addMessage(message.substring(0, 200), 'result');
        } else {
          const errorMsg = patchEndMsg.stderr || 'Failed to modify files';
          messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
        }
        logger.debug(`[copilot] Patch apply end: ${peCallId}, success: ${patchEndMsg.success}`);
        session.sendAgentMessage(ACP_PROVIDER, {
          type: 'tool-result',
          callId: peCallId,
          output: {
            stdout: patchEndMsg.stdout,
            stderr: patchEndMsg.stderr,
            success: patchEndMsg.success
          },
          id: randomUUID(),
        });
        break;
      }

      case 'event':
        if (msg.name === 'thinking') {
          const thinkingPayload = msg.payload as { text?: string } | undefined;
          const thinkingText = (thinkingPayload && typeof thinkingPayload === 'object' && 'text' in thinkingPayload)
            ? String(thinkingPayload.text || '')
            : '';
          if (thinkingText) {
            logger.debug(`[copilot] 💭 Thinking chunk: ${thinkingText.length} chars`);
            if (!thinkingText.startsWith('**')) {
              const thinkingPreview = thinkingText.substring(0, 100);
              messageBuffer.updateLastMessage(`[Thinking] ${thinkingPreview}...`, 'system');
            }
          }
          session.sendAgentMessage(ACP_PROVIDER, {
            type: 'thinking',
            text: thinkingText,
          });
        }
        break;

      default:
        if ((msg as any).type === 'token-count') {
          session.sendAgentMessage(ACP_PROVIDER, {
            type: 'token_count',
            ...(msg as any),
            id: randomUUID(),
          });
        }
        break;
    }
    });
  }

  // Note: Backend will be created dynamically in the main loop based on model from first message

  let first = true;

  try {
    let currentModeHash: string | null = null;
    let pending: { message: string; mode: CopilotMode; isolate: boolean; hash: string } | null = null;

    while (!shouldExit) {
      let message: { message: string; mode: CopilotMode; isolate: boolean; hash: string } | null = pending;
      pending = null;

      if (!message) {
        logger.debug('[copilot] Main loop: waiting for messages from queue...');
        const waitSignal = abortController.signal;
        const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
        if (!batch) {
          if (waitSignal.aborted && !shouldExit) {
            logger.debug('[copilot] Main loop: wait aborted, continuing...');
            continue;
          }
          logger.debug('[copilot] Main loop: no batch received, breaking...');
          break;
        }
        logger.debug(`[copilot] Main loop: received message from queue (length: ${batch.message.length})`);
        message = batch;
      }

      if (!message) {
        break;
      }

      // Handle mode change – restart session if permission mode or model changed
      if (wasSessionCreated && currentModeHash && message.hash !== currentModeHash) {
        logger.debug('[Copilot] Mode changed – restarting Copilot session');
        messageBuffer.addMessage('═'.repeat(40), 'status');
        messageBuffer.addMessage('Starting new Copilot session (mode changed)...', 'status');

        // Dispose old backend and create new one with new settings
        if (copilotBackend) {
          await copilotBackend.dispose();
          copilotBackend = null;
        }

        const modelToUse = message.mode?.model === undefined ? undefined : (message.mode.model || null);
        if (message.mode?.permissionMode) {
          copilotPermMode = mapToCopilotPermission(message.mode.permissionMode);
        }
        const handler = createCopilotPermissionHandler(copilotPermMode);
        const backendResult = createCopilotBackend({
          cwd: process.cwd(),
          mcpServers,
          permissionHandler: handler,
          githubToken,
          model: modelToUse,
        });
        copilotBackend = backendResult.backend;

        setupCopilotMessageHandler(copilotBackend);

        const actualModel = backendResult.model;
        logger.debug(`[copilot] Model change - modelToUse=${modelToUse}, actualModel=${actualModel} (from ${backendResult.modelSource})`);

        logger.debug('[copilot] Starting new ACP session with model:', actualModel);
        const { sessionId } = await copilotBackend.startSession();
        acpSessionId = sessionId;
        logger.debug(`[copilot] New ACP session started: ${acpSessionId}`);

        updateDisplayedModel(actualModel);

        wasSessionCreated = true;
        currentModeHash = message.hash;
        first = false;
      }

      currentModeHash = message.hash;
      const userMessageToShow = message.mode?.originalUserMessage || message.message;
      messageBuffer.addMessage(userMessageToShow, 'user');

      // Mark that we're processing a message to synchronize session swaps
      isProcessingMessage = true;

      try {
        if (first || !wasSessionCreated) {
          // First message or session not created yet - create backend and start session
          if (!copilotBackend) {
            const modelToUse = message.mode?.model === undefined ? undefined : (message.mode.model || null);
            if (message.mode?.permissionMode) {
              copilotPermMode = mapToCopilotPermission(message.mode.permissionMode);
            }
            const handler = createCopilotPermissionHandler(copilotPermMode);
            const backendResult = createCopilotBackend({
              cwd: process.cwd(),
              mcpServers,
              permissionHandler: handler,
              githubToken,
              model: modelToUse,
            });
            copilotBackend = backendResult.backend;

            setupCopilotMessageHandler(copilotBackend);

            const actualModel = backendResult.model;
            logger.debug(`[copilot] Backend created, model will be: ${actualModel} (from ${backendResult.modelSource})`);
            updateDisplayedModel(actualModel);
          }

          // Start session if not started
          if (!acpSessionId) {
            logger.debug('[copilot] Starting ACP session...');
            const { sessionId } = await copilotBackend.startSession();
            acpSessionId = sessionId;
            logger.debug(`[copilot] ACP session started: ${acpSessionId}`);
            wasSessionCreated = true;
            currentModeHash = message.hash;
          }
        }

        if (!acpSessionId) {
          throw new Error('ACP session not started');
        }

        // Reset accumulator when sending a new prompt
        accumulatedResponse = '';
        isResponseInProgress = false;
        hadToolCallInTurn = false;
        taskStartedSent = false;

        // Track if this prompt contains change_title instruction
        pendingChangeTitle = message.message.includes('change_title') ||
                             message.message.includes('happy__change_title');
        changeTitleCompleted = false;

        if (!copilotBackend || !acpSessionId) {
          throw new Error('Copilot backend or session not initialized');
        }

        const promptToSend = message.message;
        logger.debug(`[copilot] Sending prompt to Copilot (length: ${promptToSend.length}): ${promptToSend.substring(0, 100)}...`);

        // Retry logic for transient errors
        const MAX_RETRIES = 3;
        const RETRY_DELAY_MS = 2000;
        let lastError: unknown = null;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            await copilotBackend.sendPrompt(acpSessionId, promptToSend);
            logger.debug('[copilot] Prompt sent successfully');

            if (copilotBackend.waitForResponseComplete) {
              await copilotBackend.waitForResponseComplete(120000);
              logger.debug('[copilot] Response complete');
            }

            break; // Success, exit retry loop
          } catch (promptError) {
            lastError = promptError;
            const errObj = promptError as any;
            const errorDetails = errObj?.data?.details || errObj?.details || errObj?.message || '';
            const errorCode = errObj?.code;

            const isEmptyResponseError = errorDetails.includes('empty response') ||
                                         errorDetails.includes('stream ended');
            const isInternalError = errorCode === -32603;
            const isRetryable = isEmptyResponseError || isInternalError;

            if (isRetryable && attempt < MAX_RETRIES) {
              logger.debug(`[copilot] Retryable error on attempt ${attempt}/${MAX_RETRIES}: ${errorDetails}`);
              messageBuffer.addMessage(`Retrying (${attempt}/${MAX_RETRIES})...`, 'status');
              await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * attempt));
              continue;
            }

            throw promptError;
          }
        }

        if (lastError && MAX_RETRIES > 1) {
          logger.debug('[copilot] Prompt succeeded after retries');
        }

        if (first) {
          first = false;
        }
      } catch (error) {
        logger.debug('[copilot] Error in copilot session:', error);
        const isAbortError = error instanceof Error && error.name === 'AbortError';

        if (isAbortError) {
          messageBuffer.addMessage('Aborted by user', 'status');
          session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
        } else {
          let errorMsg = 'Process error occurred';

          if (typeof error === 'object' && error !== null) {
            const errObj = error as any;
            const errorDetails = errObj.data?.details || errObj.details || '';
            const errorMessage = errObj.message || errObj.error?.message || '';

            if (errorMessage.includes('not found') || errorMessage.includes('ENOENT')) {
              errorMsg = 'Failed to start Copilot. Is "copilot" CLI installed? See: https://docs.github.com/en/copilot/copilot-cli';
            } else if (errorMessage.includes('auth') || errorMessage.includes('token')) {
              errorMsg = 'Authentication failed. Try: happy connect copilot';
            } else if (Object.keys(error).length === 0) {
              errorMsg = 'Failed to start Copilot CLI. Is it installed and in your PATH?';
            } else if (errObj.message || errorMessage) {
              errorMsg = errorDetails || errorMessage || errObj.message;
            }
          } else if (error instanceof Error) {
            errorMsg = error.message;
          }

          messageBuffer.addMessage(errorMsg, 'status');
          session.sendAgentMessage(ACP_PROVIDER, {
            type: 'message',
            message: errorMsg,
          });
        }
      } finally {
        // Send accumulated response to mobile app when turn is complete
        if (accumulatedResponse.trim()) {
          logger.debug(`[copilot] Sending complete message to mobile (length: ${accumulatedResponse.length})`);
          const messagePayload: { type: 'message'; message: string; id: string } = {
            type: 'message',
            message: accumulatedResponse,
            id: randomUUID(),
          };
          session.sendAgentMessage(ACP_PROVIDER, messagePayload);
          accumulatedResponse = '';
          isResponseInProgress = false;
        }

        // Send task_complete ONCE at the end of turn
        session.sendAgentMessage(ACP_PROVIDER, {
          type: 'task_complete',
          id: randomUUID(),
        });

        // Reset tracking flags
        hadToolCallInTurn = false;
        pendingChangeTitle = false;
        changeTitleCompleted = false;
        taskStartedSent = false;

        thinking = false;
        session.keepAlive(thinking, 'remote');

        emitReadyIfIdle();

        // Message processing complete - safe to apply any pending session swap
        isProcessingMessage = false;
        applyPendingSessionSwap();

        logger.debug(`[copilot] Main loop: turn completed, continuing to next iteration (queue size: ${messageQueue.size()})`);
      }
    }

  } finally {
    // Clean up resources
    logger.debug('[copilot]: Final cleanup start');

    if (reconnectionHandle) {
      logger.debug('[copilot]: Cancelling offline reconnection');
      reconnectionHandle.cancel();
    }

    try {
      session.sendSessionDeath();
      await session.flush();
      await session.close();
    } catch (e) {
      logger.debug('[copilot]: Error while closing session', e);
    }

    if (copilotBackend) {
      await copilotBackend.dispose();
    }

    happyServer.stop();

    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch { /* ignore */ }
    }
    if (hasTTY) {
      try { process.stdin.pause(); } catch { /* ignore */ }
    }

    clearInterval(keepAliveInterval);
    if (inkInstance) {
      inkInstance.unmount();
    }
    messageBuffer.clear();

    logger.debug('[copilot]: Final cleanup completed');
  }
}

