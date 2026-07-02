import { useState, useRef, useEffect } from "react";
import "./App.css";

interface Message {
  role: "user" | "assistant";
  text: string;
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    if (!inputValue.trim() || isLoading) return;

    const userMessage = inputValue;
    setInputValue("");
    setError(null);

    // Add user message to UI
    setMessages((prev) => [...prev, { role: "user", text: userMessage }]);

    // Add placeholder for assistant message
    setMessages((prev) => [...prev, { role: "assistant", text: "" }]);
    setIsLoading(true);

    try {
      const response = await fetch("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMessage }),
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
      <div className="chat-container">
        <div className="messages">
          {messages.map((msg, idx) => (
            <div key={idx} className={`message ${msg.role}`}>
              <div className="message-content">{msg.text}</div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {error && <div className="error-banner">{error}</div>}

        <div className="input-area">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Ask the bookkeeping agent..."
            disabled={isLoading}
          />
          <button onClick={handleSend} disabled={isLoading || !inputValue.trim()}>
            {isLoading ? "Sending..." : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
