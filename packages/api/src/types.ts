// API-local shared types.

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool" | (string & {});
  content: string;
}
