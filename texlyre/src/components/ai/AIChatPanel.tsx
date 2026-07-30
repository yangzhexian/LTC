// src/components/ai/AIChatPanel.tsx
import type React from 'react';
import { useEffect, useRef, useState } from 'react';

import { useAIChat } from '../../hooks/useAIChat';
import { ChevronDownIcon, ChevronUpIcon } from '../common/Icons';

interface AIChatPanelProps {
  className?: string;
  currentDocumentContent?: string;
}

const AIChatPanel: React.FC<AIChatPanelProps> = ({
  className = '',
  currentDocumentContent,
}) => {
  const { entries, status, errorMessage, config, sendPrompt, clearHistory, updateConfig } =
    useAIChat();
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [inputValue, setInputValue] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [settingsKey, setSettingsKey] = useState(config.apiKey);
  const [settingsBaseUrl, setSettingsBaseUrl] = useState(config.baseUrl);
  const [settingsModel, setSettingsModel] = useState(config.model);
  const [includeContext, setIncludeContext] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (messagesEndRef.current && !isCollapsed) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [entries, isCollapsed]);

  const handleSend = () => {
    if (!inputValue.trim() || status === 'loading') return;
    let systemPrompt = 'You are a helpful LaTeX and typesetting assistant. Answer concisely and accurately.';
    if (includeContext && currentDocumentContent) {
      systemPrompt += `\n\nCurrent document content:\n\`\`\`latex\n${currentDocumentContent.slice(0, 8000)}\n\`\`\``;
    }
    sendPrompt(inputValue, systemPrompt);
    setInputValue('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const toggleCollapsed = () => setIsCollapsed(!isCollapsed);

  const openSettings = () => {
    setSettingsKey(config.apiKey);
    setSettingsBaseUrl(config.baseUrl);
    setSettingsModel(config.model);
    setShowSettings(true);
  };

  const saveSettings = () => {
    updateConfig({
      apiKey: settingsKey,
      baseUrl: settingsBaseUrl,
      model: settingsModel,
    });
    setShowSettings(false);
  };

  if (showSettings) {
    return (
      <div className={`ai-chat-panel ${className}`}>
        <div className='ai-chat-panel-header' onClick={() => setShowSettings(false)}>
          <span className='ai-chat-panel-title'>
            AI Settings
          </span>
          <button onClick={(e) => { e.stopPropagation(); setShowSettings(false); }}>
            <ChevronDownIcon />
          </button>
        </div>
        <div className='ai-chat-settings'>
          <label>
            API Key
            <input
              type='password'
              value={settingsKey}
              onChange={(e) => setSettingsKey(e.target.value)}
              placeholder='sk-...'
            />
          </label>
          <label>
            API Base URL
            <input
              value={settingsBaseUrl}
              onChange={(e) => setSettingsBaseUrl(e.target.value)}
              placeholder='https://api.openai.com/v1'
            />
          </label>
          <label>
            Model
            <input
              value={settingsModel}
              onChange={(e) => setSettingsModel(e.target.value)}
              placeholder='gpt-4o-mini'
            />
          </label>
          <div className='ai-chat-settings-actions'>
            <button onClick={saveSettings}>Save</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`ai-chat-panel ${isCollapsed ? 'collapsed' : 'expanded'} ${className}`}
    >
      <div className='ai-chat-panel-header' onClick={toggleCollapsed}>
        <span className='ai-chat-panel-title'>
          AI Assistant
          <span className='ai-badge'>AI</span>
        </span>
        <div className='ai-chat-panel-controls'>
          <button
            title='Settings'
            onClick={(e) => {
              e.stopPropagation();
              openSettings();
            }}
          >
            ⚙
          </button>
          <button
            title='Clear history'
            onClick={(e) => {
              e.stopPropagation();
              clearHistory();
            }}
          >
            ✕
          </button>
          <button className='collapse-toggle'>
            {isCollapsed ? <ChevronUpIcon /> : <ChevronDownIcon />}
          </button>
        </div>
      </div>

      {!isCollapsed && (
        <div className='ai-chat-panel-content'>
          <div className='ai-chat-messages'>
            {entries.length === 0 ? (
              <div className='ai-chat-empty'>
                <p>Ask AI about your LaTeX code,<br />get suggestions, or debug errors.</p>
              </div>
            ) : (
              entries.map((entry) => (
                <div
                  key={entry.id}
                  className={`ai-chat-message ${entry.role}`}
                >
                  <div className='ai-chat-message-label'>
                    {entry.role === 'user' ? 'You' : 'AI'}
                  </div>
                  <div>{entry.content}</div>
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          {status === 'loading' && (
            <div className='ai-chat-status loading'>
              <span className='ai-chat-spinner' />
              AI is thinking...
            </div>
          )}
          {status === 'error' && errorMessage && (
            <div className='ai-chat-status error'>{errorMessage}</div>
          )}

          <div className='ai-chat-input-container'>
            <textarea
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder='Ask AI about your document...'
              className='ai-chat-input'
              disabled={status === 'loading'}
              rows={1}
            />
            <button
              onClick={handleSend}
              disabled={!inputValue.trim() || status === 'loading'}
              className='ai-chat-send-button'
            >
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default AIChatPanel;
