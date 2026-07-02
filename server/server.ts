import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { getChatSession, setIsStreaming, getIsStreaming } from "./chatSession.js";
import { writeSseEvent } from "./sse.js";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cwd = path.dirname(__dirname);

export function createApp() {
  const app = express();

  app.use(express.json());
  app.use(express.static(path.join(cwd, "web/dist")));

  app.post("/chat", async (req, res) => {
    const { message } = req.body;

    // Validate message
    if (!message || typeof message !== "string" || message.trim() === "") {
      res.status(400).json({ error: "Missing or empty message" });
      return;
    }

    // Check if already streaming
    if (getIsStreaming()) {
      res.status(409).json({ error: "Session is already processing" });
      return;
    }

    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // If the client disconnects mid-stream, don't leave the single shared
    // session locked for the full (possibly long) remaining generation —
    // release the guard immediately and abort the in-flight prompt so it
    // stops consuming model tokens for a response nobody will see. Must use
    // res's "close" (writable side), not req's — req.on("close") fires once
    // the request body finishes being read, well before the response ends.
    let clientDisconnected = false;
    res.on("close", () => {
      if (res.writableEnded) return;
      clientDisconnected = true;
      setIsStreaming(false);
      getChatSession()
        .then((session) => session.abort())
        .catch(() => {});
    });

    try {
      setIsStreaming(true);
      const session = await getChatSession();

      // Subscribe to session events
      const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        if (clientDisconnected) return;
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta"
        ) {
          writeSseEvent(res, "delta", {
            text: event.assistantMessageEvent.delta,
          });
        } else if (event.type === "tool_execution_start") {
          writeSseEvent(res, "tool", {
            status: "start",
            toolName: event.toolName,
          });
        } else if (event.type === "tool_execution_end") {
          writeSseEvent(res, "tool", {
            status: "end",
            toolName: event.toolName,
          });
        }
      });

      try {
        await session.prompt(message);
      } catch (error) {
        if (!clientDisconnected) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          writeSseEvent(res, "error", { message: errorMessage });
        }
      } finally {
        unsubscribe();
      }
    } catch (error) {
      if (!clientDisconnected) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        writeSseEvent(res, "error", { message: errorMessage });
      }
    } finally {
      if (!clientDisconnected) {
        setIsStreaming(false);
      }
      if (!res.writableEnded) {
        res.end();
      }
    }
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp();
  const port = process.env.PORT ?? 3000;
  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}
