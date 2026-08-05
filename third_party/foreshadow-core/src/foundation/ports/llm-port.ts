export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
}

export interface LLMToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
}

export interface LLMToolDefinition {
  name: string;
  description: string;
  schema: any;
  func: (args: any) => Promise<string> | string;
}

export interface LLMChatResult {
  content: string;
  tool_calls?: LLMToolCall[];
  raw?: any;
}

export interface LLMPort {
  isConfigured(): boolean;
  chat(messages: LLMMessage[], tools?: LLMToolDefinition[]): Promise<LLMChatResult>;
}
