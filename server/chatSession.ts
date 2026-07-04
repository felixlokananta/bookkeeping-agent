import { createAgentSession, type AgentSession } from "@earendil-works/pi-coding-agent";

let session: AgentSession | null = null;
let isStreaming = false;

export async function getChatSession(): Promise<AgentSession> {
  if (!session) {
    const result = await createAgentSession({ noTools: "builtin" });
    session = result.session;
    // createAgentSession() does not itself fire session_start — extensions
    // (which open the ledger in their session_start handler) stay unbound
    // until bindExtensions() is called, same as interactive-mode.js does
    // for the TUI. Without this, every ledger tool call fails with
    // "Ledger not initialized".
    await session.bindExtensions({});
  }
  return session;
}

export function setIsStreaming(value: boolean): void {
  isStreaming = value;
}

export function getIsStreaming(): boolean {
  return isStreaming;
}
