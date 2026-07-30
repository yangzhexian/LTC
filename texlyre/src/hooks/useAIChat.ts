// src/hooks/useAIChat.ts
import { useContext } from 'react';

import { AIChatContext, type AIChatContextType } from '../contexts/AIChatContext';

export const useAIChat = (): AIChatContextType => {
  const context = useContext(AIChatContext);
  if (!context) {
    throw new Error('useAIChat must be used within an AIChatProvider');
  }
  return context;
};
