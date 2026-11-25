import { tag, text, unique } from "../clean.js";
import type { TagProvider } from "../types.js";

/**
 * Chats with an AI assistant that the owner sends in by hand: Claude Code
 * sessions (the send-session plugin skill) now, and later saved Claude.ai
 * chats, which reuse this provider under their own source name. A chat
 * carries one tag: the project it was had in (the Claude Code folder name).
 * The name, in lower case, is the id, so the same folder always gives the
 * same tag. Like every tag it gives no topic until switched on, so a session
 * stays with its owner.
 */
export function chatProvider(source: string): TagProvider {
  return {
    source,
    kinds: ["project"],
    howToRead: 'Pass the project the chat was had in as {"kind": "project", "id": "<project name>", "name": "<project name>"}.',
    normalize: (raw) =>
      unique(
        raw.map((r) => {
          if (text(r.kind) !== "project") return null;
          const name = text(r.name) || text(r.id);
          return name ? tag("project", name.toLowerCase(), name) : null;
        }),
      ),
  };
}

export const claudeCodeProvider: TagProvider = chatProvider("claude-code");
