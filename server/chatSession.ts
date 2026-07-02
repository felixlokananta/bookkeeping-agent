import { createAgentSession, type AgentSession } from "@earendil-works/pi-coding-agent";

let session: AgentSession | null = null;
let isStreaming = false;

export async function getChatSession(): Promise<AgentSession> {
  if (!session) {
    const result = await createAgentSession({ noTools: "builtin" });
    session = result.session;
  }
  return session;
}

export function setIsStreaming(value: boolean): void {
  isStreaming = value;
}

export function getIsStreaming(): boolean {
  return isStreaming;
}
