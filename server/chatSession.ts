import { createAgentSession, type AgentSession } from "@earendil-works/pi-coding-agent";

let sessionPromise: Promise<AgentSession> | null = null;
let isStreaming = false;

export async function getChatSession(): Promise<AgentSession> {
  if (!sessionPromise) {
    // Cache the in-flight promise (not just the resolved session) so
    // concurrent callers during startup await the same bind instead of one
    // of them observing a session before bindExtensions() below resolves.
    sessionPromise = (async () => {
      const result = await createAgentSession({ noTools: "builtin" });
      // createAgentSession() does not itself fire session_start — extensions
      // (which open the ledger in their session_start handler) stay unbound
      // until bindExtensions() is called, same as interactive-mode.js does
      // for the TUI. Without this, every ledger tool call fails with
      // "Ledger not initialized".
      await result.session.bindExtensions({
        onError: (err) => console.error("chat session extension error:", err),
      });
      return result.session;
    })();
  }
  return sessionPromise;
}

export function setIsStreaming(value: boolean): void {
  isStreaming = value;
}

export function getIsStreaming(): boolean {
  return isStreaming;
}
