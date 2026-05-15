import { describe, expect, it } from "vitest";
import {
  extractUserUtteranceFromInternalSlugPrompt,
  normalizeUserChatDisplay,
  stripUserBubbleDecorations,
} from "./userChatDisplay";

describe("stripUserBubbleDecorations", () => {
  it("removes Sender json fence at start", () => {
    const raw = `Sender (untrusted metadata):
\`\`\`json
{ "label": "gateway-client" }
\`\`\`

고양이`;
    expect(stripUserBubbleDecorations(raw)).toBe("고양이");
  });

  it("strips repeated leading [timestamp] prefixes", () => {
    expect(stripUserBubbleDecorations("[a] [b] hi")).toBe("hi");
  });
});

describe("extractUserUtteranceFromInternalSlugPrompt", () => {
  it("returns null for normal user text", () => {
    expect(extractUserUtteranceFromInternalSlugPrompt("고양이가 해변에서 노는 이미지 만들어줘.")).toBeNull();
  });

  it("extracts bracket timestamp line from OpenClaw slug internal prompt", () => {
    const blob = `Based on this conversation, generate a short 1-2 word filename slug (lowercase, hyphen-separated, no file extension).

Conversation summary:
user: Sender (untrusted metadata):
\`\`\`json
{ "label": "gateway-client" }
\`\`\`

[Mon 2026-05-04 17:43 GMT+9] 고양이가 해변에서 노는 이미지 만들어줘.
assistant: hello

Reply with ONLY the slug, nothing else.`;
    expect(extractUserUtteranceFromInternalSlugPrompt(blob)).toBe(
      "고양이가 해변에서 노는 이미지 만들어줘.",
    );
  });
});

describe("normalizeUserChatDisplay", () => {
  it("collapses internal slug prompt to user line", () => {
    const blob = `Based on this conversation, generate a short 1-2 word filename slug.

[Mon 2026-05-04 17:43 GMT+9] 고양이가 해변에서 노는 이미지 만들어줘.

Reply with ONLY the slug`;
    expect(normalizeUserChatDisplay(blob)).toBe("고양이가 해변에서 노는 이미지 만들어줘.");
  });
});
