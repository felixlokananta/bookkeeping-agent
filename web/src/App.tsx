import { useState, useRef, useEffect } from "react";
import "./App.css";

interface Message {
  role: "user" | "assistant";
  text: string;
  attachmentNames?: string[];
}

interface PendingAttachment {
  id: string;
  file: File;
  previewUrl: string;
}

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // mirrors server default BOOKKEEPING_MAX_UPLOAD_BYTES
const MAX_ATTACHMENTS = 5; // mirrors server default BOOKKEEPING_MAX_ATTACHMENTS
const SUPPORTED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]);

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const addFiles = (files: FileList | File[]) => {
    const fileArray = Array.from(files);

    for (const file of fileArray) {
      if (!SUPPORTED_MIME_TYPES.has(file.type)) {
        setError(`Unsupported file type "${file.type}" for "${file.name}". Supported: PNG, JPG, GIF, WebP, PDF.`);
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        setError(
          `"${file.name}" is too large (${Math.ceil(file.size / 1024 / 1024)}MB, max ${Math.ceil(MAX_UPLOAD_BYTES / 1024 / 1024)}MB)`
        );
        return;
      }
    }

    // Computed from the closure value (safe here — addFiles only ever runs
    // from a discrete user event, never during render), not a functional
    // setState updater, so setError can be called plainly instead of as a
    // side effect inside the updater callback.
    const availableSlots = MAX_ATTACHMENTS - pendingAttachments.length;
    if (availableSlots <= 0 || fileArray.length > availableSlots) {
      setError(`Too many attachments: max ${MAX_ATTACHMENTS} per message`);
    }
    if (availableSlots <= 0) return;

    const accepted = fileArray.slice(0, availableSlots).map((file) => ({
      id: Math.random().toString(36),
      file,
      previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : "",
    }));

    setPendingAttachments((prev) => [...prev, ...accepted]);
  };

  const removeAttachment = (id: string) => {
    setPendingAttachments((prev) => {
      const updated = prev.filter((att) => att.id !== id);
      const toRemove = prev.find((att) => att.id === id);
      if (toRemove?.previewUrl) {
        URL.revokeObjectURL(toRemove.previewUrl);
      }
      return updated;
    });
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(",")[1]; // strip "data:...;base64," prefix
        resolve(base64);
      };
      reader.onerror = reject;
    });
  };

  const handleSend = async () => {
    if ((!inputValue.trim() && pendingAttachments.length === 0) || isLoading) return;

    const userMessage = inputValue;
    const attachmentsToSend = [...pendingAttachments];

    setInputValue("");
    setError(null);
    setPendingAttachments([]);
    for (const att of attachmentsToSend) {
      if (att.previewUrl) {
        URL.revokeObjectURL(att.previewUrl);
      }
    }

    // Add user message to UI
    setMessages((prev) => [...prev, {
      role: "user",
      text: userMessage,
      attachmentNames: attachmentsToSend.map((a) => a.file.name),
    }]);

    // Add placeholder for assistant message
    setMessages((prev) => [...prev, { role: "assistant", text: "" }]);
    setIsLoading(true);

    try {
      // Base64 encode all attachments
      const attachments = await Promise.all(
        attachmentsToSend.map(async (att) => ({
          filename: att.file.name,
          mimeType: att.file.type,
          data: await fileToBase64(att.file),
        }))
      );

      const response = await fetch("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMessage,
          ...(attachments.length > 0 && { attachments }),
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error("No response body");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Each SSE frame is terminated by a blank line ("\n\n"). Splitting on
      // that (rather than single "\n") keeps a frame intact even if a
      // network chunk boundary falls between its "event:" and "data:" lines.
      const processFrame = (frame: string) => {
        let eventType: string | null = null;
        let dataLine: string | null = null;
        for (const line of frame.split("\n")) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            dataLine = line.slice(6);
          }
        }
        if (!eventType || dataLine === null) return;

        try {
          const data = JSON.parse(dataLine);

          if (eventType === "delta" && data.text) {
            // Append text to the last assistant message
            setMessages((prev) => {
              const updated = [...prev];
              if (updated[updated.length - 1]?.role === "assistant") {
                updated[updated.length - 1].text += data.text;
              }
              return updated;
            });
          } else if (eventType === "error") {
            setError(data.message || "Unknown error");
          }
          // Ignore "tool" events for now (used for UI polish later)
        } catch (e) {
          console.error("Failed to parse SSE data:", dataLine, e);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? ""; // keep the trailing incomplete frame

        for (const frame of frames) {
          processFrame(frame);
        }
      }

      // Handle a final frame that wasn't followed by a trailing blank line.
      if (buffer.trim()) {
        processFrame(buffer);
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Unknown error";
      setError(errorMessage);
      // Remove the empty assistant message on error
      setMessages((prev) => prev.slice(0, -1));
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="app">
      <div
        className={`chat-container ${isDragOver ? "drag-over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragOver(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        <div className="messages">
          {messages.map((msg, idx) => (
            <div key={idx} className={`message ${msg.role}`}>
              <div className="message-content">
                {msg.text}
                {msg.attachmentNames && msg.attachmentNames.length > 0 && (
                  <div className="message-attachments">
                    {msg.attachmentNames.map((name, i) => (
                      <span key={i} className="message-attachment-tag">
                        📎 {name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {error && <div className="error-banner">{error}</div>}

        {pendingAttachments.length > 0 && (
          <div className="attachment-preview-strip">
            {pendingAttachments.map((att) => (
              <div key={att.id} className="attachment-thumbnail">
                {att.previewUrl ? (
                  <img src={att.previewUrl} alt={att.file.name} />
                ) : (
                  <div className="attachment-file-icon">📄</div>
                )}
                <div className="attachment-filename">{att.file.name}</div>
                <button
                  className="attachment-remove-btn"
                  onClick={() => removeAttachment(att.id)}
                  type="button"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="input-area">
          <input
            type="file"
            ref={fileInputRef}
            multiple
            accept="image/png,image/jpeg,image/gif,image/webp,application/pdf"
            onChange={(e) => {
              if (e.target.files) {
                addFiles(e.target.files);
                e.target.value = "";
              }
            }}
            style={{ display: "none" }}
          />
          <button
            className="attach-button"
            onClick={() => fileInputRef.current?.click()}
            type="button"
            disabled={isLoading}
          >
            📎
          </button>
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Ask the bookkeeping agent..."
            disabled={isLoading}
          />
          <button onClick={handleSend} disabled={isLoading || (!inputValue.trim() && pendingAttachments.length === 0)}>
            {isLoading ? "Sending..." : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
