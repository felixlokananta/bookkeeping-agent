import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { getChatSession, setIsStreaming, getIsStreaming } from "./chatSession.js";
import { writeSseEvent } from "./sse.js";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { processAttachments, AttachmentError, type Attachment } from "./attachments.js";
import { getMaxUploadBytes, getMaxAttachments } from "./uploadConfig.js";
import { detectAutoPostBlock } from "./approvalDetection.js";
import { authMiddleware, getAuthToken } from "./auth.js";
import { getBindHost, assertSafeBindConfig } from "./network.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cwd = path.dirname(__dirname);

export function createApp() {
  const app = express();

  app.use(express.json({ limit: getMaxUploadBytes() * getMaxAttachments() * 2 }));
  app.use(express.static(path.join(cwd, "web/dist")));

  app.post("/chat", authMiddleware, async (req, res) => {
    const { message, attachments } = req.body;

    // Validate message and attachments
    const hasText = typeof message === "string" && message.trim() !== "";
    if (attachments !== undefined && !Array.isArray(attachments)) {
      res.status(400).json({ error: "attachments must be an array" });
      return;
    }
    const rawAttachments: unknown[] = Array.isArray(attachments) ? attachments : [];

    if (!hasText && rawAttachments.length === 0) {
      res.status(400).json({ error: "Missing or empty message" });
      return;
    }

    // Check if already streaming before paying the cost of attachment
    // processing (PDF rasterization in particular is not cheap) — a request
    // that's going to be rejected with 409 shouldn't rasterize PDFs first.
    if (getIsStreaming()) {
      res.status(409).json({ error: "Session is already processing" });
      return;
    }

    let images: { type: "image"; data: string; mimeType: string }[] = [];
    let csvPaths: string[] = [];
    if (rawAttachments.length > 0) {
      try {
        ({ images, csvPaths } = await processAttachments(rawAttachments as Attachment[]));
      } catch (err) {
        if (err instanceof AttachmentError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
    }

    const baseMessage = hasText ? (message as string) : "Process the attached file(s).";
    const csvNote =
      csvPaths.length > 0
        ? `\n\n[Uploaded CSV file(s) saved to: ${csvPaths.join(", ")}. Use import_csv to import them.]`
        : "";
    const effectiveMessage = baseMessage + csvNote;

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

      // Track tool call arguments for approval detection
      const pendingToolArgs = new Map<string, { toolName: string; args: any }>();

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
          pendingToolArgs.set(event.toolCallId, { toolName: event.toolName, args: event.args });
          writeSseEvent(res, "tool", {
            status: "start",
            toolName: event.toolName,
          });
        } else if (event.type === "tool_execution_end") {
          const pending = pendingToolArgs.get(event.toolCallId);
          pendingToolArgs.delete(event.toolCallId);

          const approval = pending
            ? detectAutoPostBlock(event.toolCallId, event.toolName, pending.args, event.result, event.isError)
            : null;
          if (approval) {
            writeSseEvent(res, "approval_required", approval);
          }

          writeSseEvent(res, "tool", {
            status: "end",
            toolName: event.toolName,
          });
        }
      });

      try {
        await session.prompt(effectiveMessage, images.length > 0 ? { images } : undefined);
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

  // Body-parser failures (e.g. a request body over the express.json() limit)
  // call next(err) before any route handler runs, bypassing the JSON error
  // contract every route in this app otherwise guarantees. Catch them here
  // so oversized uploads get a clean {error} JSON response instead of
  // Express's default HTML error page (which also leaks internal file paths
  // via the stack trace).
  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (err && err.type === "entity.too.large") {
        res.status(413).json({ error: "Request body too large" });
        return;
      }
      next(err);
    }
  );

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp();
  const port = parseInt(process.env.PORT ?? "3000", 10);
  const host = getBindHost();
  assertSafeBindConfig(host, getAuthToken());
  app.listen(port, host, () => {
    console.log(`Server running at http://${host}:${port}`);
  });
}
