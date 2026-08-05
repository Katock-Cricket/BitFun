/**
 * BitFun LLMPort for TaskRecognizer.
 *
 * Uses ephemeral editor_ai_stream (no session persistence). Tool calling is not
 * supported by that path; TaskRecognizer still works without tool_calls (B15).
 */
import type {
  ConfigPort,
  LLMChatResult,
  LLMMessage,
  LLMPort,
  LLMToolDefinition,
} from '@foreshadow/core';
import { createLogger } from '@/shared/utils/logger';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import type { AIModelConfig, DefaultModelsConfig, ForeshadowConfig } from '@/infrastructure/config/types';
import { editorAiAPI } from '@/infrastructure/api/service-api/EditorAiAPI';
import {
  hasConfiguredAiModel,
  resolveForeshadowTaskModelId,
} from './modelResolve';

const log = createLogger('ForeshadowLlmPort');

function createRequestId(): string {
  try {
    const fn = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
    if (fn) {
      return `foreshadow-task-${fn()}`;
    }
  } catch {
    // fall through
  }
  return `foreshadow-task-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function messagesToPrompt(messages: LLMMessage[]): string {
  return messages
    .map((message) => {
      const role = message.role.toUpperCase();
      if (message.role === 'tool') {
        return `[TOOL${message.tool_call_id ? ` ${message.tool_call_id}` : ''}]\n${message.content}`;
      }
      return `[${role}]\n${message.content}`;
    })
    .join('\n\n');
}

async function streamOnce(modelId: string, prompt: string): Promise<string> {
  const requestId = createRequestId();
  let responseText = '';

  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    let unlistenChunk = () => {};
    let unlistenCompleted = () => {};
    let unlistenFailed = () => {};

    const cleanup = () => {
      try { unlistenChunk(); } catch { /* ignore */ }
      try { unlistenCompleted(); } catch { /* ignore */ }
      try { unlistenFailed(); } catch { /* ignore */ }
    };

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    unlistenChunk = editorAiAPI.onTextChunk((event) => {
      if (event.requestId !== requestId || !event.text) {
        return;
      }
      responseText += event.text;
    });

    unlistenCompleted = editorAiAPI.onCompleted((event) => {
      if (event.requestId !== requestId) {
        return;
      }
      const finalText = event.fullText && event.fullText.length >= responseText.length
        ? event.fullText
        : responseText;
      settle(() => resolve(finalText.trim()));
    });

    unlistenFailed = editorAiAPI.onError((event) => {
      if (event.requestId !== requestId) {
        return;
      }
      settle(() => reject(new Error(event.error || 'Foreshadow LLM stream failed')));
    });

    void editorAiAPI
      .stream({ requestId, prompt, modelId })
      .catch((error) => {
        settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      });
  });
}

export function createLlmPort(options: {
  getConfig: () => ForeshadowConfig;
  /** Optional ConfigPort kept for symmetry with VS Code host; unused beyond getConfig. */
  configPort?: ConfigPort;
}): LLMPort {
  let configuredCache: boolean | null = null;
  let configuredCheckedAt = 0;
  const CONFIGURED_TTL_MS = 5_000;

  const refreshConfigured = async (): Promise<boolean> => {
    try {
      const [models, defaults] = await Promise.all([
        configManager.getConfig<AIModelConfig[]>('ai.models'),
        configManager.getConfig<DefaultModelsConfig>('ai.default_models'),
      ]);
      const ok = hasConfiguredAiModel({ models, defaults });
      configuredCache = ok;
      configuredCheckedAt = Date.now();
      return ok;
    } catch (error) {
      log.warn('Failed to resolve AI model configuration for foreshadow', { error });
      configuredCache = false;
      configuredCheckedAt = Date.now();
      return false;
    }
  };

  // Warm cache without blocking construction.
  void refreshConfigured();

  return {
    isConfigured(): boolean {
      if (configuredCache == null || Date.now() - configuredCheckedAt > CONFIGURED_TTL_MS) {
        void refreshConfigured();
      }
      return configuredCache === true;
    },

    async chat(
      messages: LLMMessage[],
      _tools?: LLMToolDefinition[],
    ): Promise<LLMChatResult> {
      // Soft-fail path: never throw into TaskRecognizer hard path.
      try {
        const configured = await refreshConfigured();
        if (!configured) {
          return { content: '' };
        }

        let defaults: DefaultModelsConfig | null = null;
        try {
          defaults = await configManager.getConfig<DefaultModelsConfig>('ai.default_models');
        } catch {
          defaults = null;
        }

        const modelId = resolveForeshadowTaskModelId(options.getConfig(), defaults);
        const prompt = messagesToPrompt(messages);
        if (!prompt.trim()) {
          return { content: '' };
        }

        const content = await streamOnce(modelId, prompt);
        // editor_ai_stream does not bind tools; TaskRecognizer continues without tool_calls.
        return { content };
      } catch (error) {
        log.warn('Foreshadow LLM chat failed; returning empty content', { error });
        return { content: '' };
      }
    },
  };
}
