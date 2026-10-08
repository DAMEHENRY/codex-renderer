import { cloneMessage, getImageOnlyPromptAndDisplay, type ContextChip } from "./session-logic";

export interface RewindMessage {
  role: "user" | "assistant";
  content: string;
  displayContent: string;
  composerText?: string;
  contextAttachments: ContextChip[];
}

export interface StoredTurn {
  id: string;
  status: string;
  itemsView?: string;
  items: Array<{
    type: string;
    content?: Array<{ type: string; text?: string }>;
  }>;
}

/** Match the actual submitted prompts, not bubble text or estimated turn counts. */
export function findRewindBoundary(messages: RewindMessage[], index: number, turns: StoredTurn[]): number {
  if (!Number.isInteger(index) || index < 0 || messages[index]?.role !== "user") {
    throw new Error("Choose a user message to rewind.");
  }
  const prompts = messages.slice(0, index + 1).filter((message) => message.role === "user");
  let matched = 0;
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (!turn.id || !Array.isArray(turn.items) || (turn.itemsView && turn.itemsView !== "full")) {
      throw new Error("Codex did not return complete turn history. Nothing was changed.");
    }
    const users = turn.items.filter((item) => item.type === "userMessage");
    if (!users.length) continue;
    const text = users[0].content?.filter((part) => part.type === "text").map((part) => part.text || "").join("\n");
    if (users.length !== 1 || text !== prompts[matched].content) {
      throw new Error("This chat no longer matches its saved Codex history. Nothing was changed.");
    }
    matched++;
    if (matched === prompts.length) {
      if (turns.slice(0, i + 1).some((entry) => entry.status === "inProgress")) {
        throw new Error("Wait for Codex to finish before rewinding.");
      }
      return i;
    }
  }
  throw new Error("The selected message was not found in Codex history. Nothing was changed.");
}

export function getRewindDraft(message: RewindMessage): { text: string; chips: ContextChip[] } {
  const chips = cloneMessage(message.contextAttachments || []);
  const imageOnlyDisplay = getImageOnlyPromptAndDisplay(true, "").displayContent;
  return {
    text: message.composerText ?? (chips.some((chip) => chip.type === "image") && message.displayContent === imageOnlyDisplay ? "" : message.displayContent),
    chips,
  };
}

/** A CLI ignoring an unsupported fork boundary must never become a fake rewind. */
export function verifyRewindFork(expected: StoredTurn[], actual: StoredTurn[]): void {
  const signature = (turns: StoredTurn[]) => turns.map((turn) => ({
    id: turn.id,
    users: turn.items.filter((item) => item.type === "userMessage").map((item) => item.content),
  }));
  if (JSON.stringify(signature(expected)) !== JSON.stringify(signature(actual))) {
    throw new Error("This Codex CLI did not fork at the requested message. Update Codex and retry; the original chat is unchanged.");
  }
}
