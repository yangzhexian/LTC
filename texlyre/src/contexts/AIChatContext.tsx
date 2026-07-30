// src/contexts/AIChatContext.tsx
import type React from 'react';
import {
  type ReactNode,
  createContext,
  useCallback,
  useRef,
  useState,
} from 'react';

import { useSecrets } from '../hooks/useSecrets';
import {
  sendChatMessage,
  type AIChatMessage,
  type AIChatConfig,
} from '../services/AIService';
import { createNamedLogger } from '@/logging';

const moduleLog = createNamedLogger('AIChatContext');

export interface AIChatEntry {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export type AIChatStatus = 'idle' | 'loading' | 'error';

export interface AIChatContextType {
  entries: AIChatEntry[];
  status: AIChatStatus;
  errorMessage: string | null;
  config: AIChatConfig;
  sendPrompt: (prompt: string, systemPrompt?: string) => Promise<void>;
  clearHistory: () => void;
  updateConfig: (partial: Partial<AIChatConfig>) => void;
}

const PLUGIN_ID = 'ai-assistant';
const SECRET_KEY = 'apiKey';

export const AIChatContext = createContext<AIChatContextType | null>(null);

interface AIChatProviderProps {
  children: ReactNode;
}

export const AIChatProvider: React.FC<AIChatProviderProps> = ({ children }) => {
  const { getSecret, setSecret } = useSecrets();
  const [entries, setEntries] = useState<AIChatEntry[]>([]);
  const [status, setStatus] = useState<AIChatStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [config, setConfig] = useState<AIChatConfig>({
    apiKey: '',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  });
  const configLoaded = useRef(false);

  if (!configLoaded.current) {
    getSecret(PLUGIN_ID, SECRET_KEY).then((secret) => {
      if (secret?.value) {
        setConfig((prev) => ({ ...prev, apiKey: secret.value }));
      }
    }).catch(() => {});
    const storedBaseUrl = localStorage.getItem('texlyre-ai-base-url');
    const storedModel = localStorage.getItem('texlyre-ai-model');
    if (storedBaseUrl) {
      setConfig((prev) => ({ ...prev, baseUrl: storedBaseUrl }));
    }
    if (storedModel) {
      setConfig((prev) => ({ ...prev, model: storedModel }));
    }
    configLoaded.current = true;
  }

  const updateConfig = useCallback(
    (partial: Partial<AIChatConfig>) => {
      setConfig((prev) => {
        const next = { ...prev, ...partial };
        if (partial.apiKey !== undefined) {
          setSecret(PLUGIN_ID, SECRET_KEY, partial.apiKey).catch((err) =>
            moduleLog.error('Failed to save API key', err),
          );
        }
        if (partial.baseUrl !== undefined) {
          localStorage.setItem('texlyre-ai-base-url', partial.baseUrl);
        }
        if (partial.model !== undefined) {
          localStorage.setItem('texlyre-ai-model', partial.model);
        }
        return next;
      });
    },
    [setSecret],
  );

  const clearHistory = useCallback(() => {
    setEntries([]);
    setErrorMessage(null);
    setStatus('idle');
  }, []);

  const sendPrompt = useCallback(
    async (prompt: string, systemPrompt?: string) => {
      if (!config.apiKey) {
        setErrorMessage('API key not configured. Open AI chat settings to set it.');
        setStatus('error');
        return;
      }

      const userEntry: AIChatEntry = {
        id: Date.now().toString() + Math.random().toString(36).substring(2, 9),
        role: 'user',
        content: prompt,
        timestamp: Date.now(),
      };
      setEntries((prev) => [...prev, userEntry]);
      setStatus('loading');
      setErrorMessage(null);

      const messages: AIChatMessage[] = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      for (const e of entries) {
        messages.push({ role: e.role, content: e.content });
      }
      messages.push({ role: 'user', content: prompt });

      const assistantEntry: AIChatEntry = {
        id: (Date.now() + 1).toString() + Math.random().toString(36).substring(2, 9),
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
      };
      setEntries((prev) => [...prev, assistantEntry]);

      try {
        let fullContent = '';
        await sendChatMessage(messages, config, (chunk) => {
          fullContent += chunk;
          setEntries((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last && last.role === 'assistant') {
              copy[copy.length - 1] = { ...last, content: fullContent };
            }
            return copy;
          });
        });
        setStatus('idle');
      } catch (err: any) {
        moduleLog.error('AI chat error', err);
        setErrorMessage(err?.message || 'Unknown error');
        setStatus('error');
        setEntries((prev) => prev.filter((e) => e.id !== assistantEntry.id));
      }
    },
    [config, entries],
  );

  return (
    <AIChatContext.Provider
      value={{ entries, status, errorMessage, config, sendPrompt, clearHistory, updateConfig }}
    >
      {children}
    </AIChatContext.Provider>
  );
};
