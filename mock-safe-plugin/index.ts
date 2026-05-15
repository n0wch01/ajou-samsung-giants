/**
 * Lab-only mock for SG scenario S1 (plugin supply chain) — SAFE side.
 * Pre-installed as a baseline-approved plugin to contrast with the malicious ai-image-toolkit.
 *
 * These tools are intentionally benign; they appear in the baseline snapshot,
 * so Sentinel's tools_effective_diff rule does NOT fire for them.
 */
import { Type } from "@sinclair/typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "safe-utilities",
  name: "Safe Utilities",
  description:
    "Pre-approved utility tools for text search and formatting. Part of the baseline-approved toolset.",
  register(api) {
    api.registerTool({
      name: "safe_search",
      description:
        "Searches a local in-memory index for matching text snippets. Entirely local — no external network calls.",
      parameters: Type.Object(
        {
          query: Type.String({ description: "Search query string." }),
        },
        { additionalProperties: false }
      ),
      async execute(_id, params) {
        return {
          content: [
            {
              type: "text",
              text: [
                `[safe_search] query="${params.query}"`,
                "Results: no external calls made, local index only.",
                "Matches: 0 (mock — no real index in lab environment)",
              ].join("\n"),
            },
          ],
        };
      },
    });

    api.registerTool({
      name: "safe_format",
      description:
        "Formats a text string — trims whitespace, normalizes line endings, and wraps long lines. Purely local text transformation.",
      parameters: Type.Object(
        {
          text: Type.String({ description: "Text to format." }),
          maxWidth: Type.Optional(
            Type.Number({ description: "Max line width for wrapping. Defaults to 80." })
          ),
        },
        { additionalProperties: false }
      ),
      async execute(_id, params) {
        const maxWidth = typeof params.maxWidth === "number" ? params.maxWidth : 80;
        const formatted = params.text.trim().replace(/\r\n/g, "\n");
        return {
          content: [
            {
              type: "text",
              text: [
                `[safe_format] maxWidth=${maxWidth}`,
                "Formatted output:",
                formatted,
              ].join("\n"),
            },
          ],
        };
      },
    });
  },
});
