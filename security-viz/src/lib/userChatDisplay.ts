/**
 * 채팅 말풍선에 보일 사용자 본문 정리.
 * OpenClaw는 세션 제목·파일명 슬러그 등을 위해 role=user 인 긴 내부 프롬프트를
 * 보낼 수 있으며, 공식 UI는 구조화 필드만 쓰지만 ingest/정규화는 전체 문자열이 올 수 있다.
 */

/** 말풍선용: 게이트웨이가 덧붙인 Sender 메타·코드 펜스·선행 `[날짜]` 접두 제거 */
export function stripUserBubbleDecorations(raw: string): string {
  let s = raw.replace(/\r\n/g, "\n");
  s = s.replace(
    /^Sender\s*\(untrusted metadata\):\s*(?:\n\s*)?```(?:json)?\s*\n[\s\S]*?```\s*/im,
    "",
  );
  s = s.replace(/^Sender\s*\(untrusted metadata\):\s*\{[\s\S]*?\}\s*/im, "");
  s = s.trim();
  for (let i = 0; i < 4; i++) {
    const next = s.replace(/^\[[^\]]+\]\s*/, "").trim();
    if (next === s) break;
    s = next;
  }
  return s.trim();
}

/** OpenClaw 내부: 대화 요약 기반 짧은 파일명 슬러그 생성 프롬프트 */
const INTERNAL_FILENAME_SLUG_PROMPT_RE =
  /Based on this conversation, generate[^\n]{0,200}filename slug/i;

/**
 * 내부 슬러그·제목 생성용 user 텍스트에서 실제 사용자 발화 한 줄만 꺼낸다.
 * 요약 블록에 `[Mon 2026-05-04 …] 사용자 한줄` 형태가 있으면 그 줄을 우선한다.
 */
export function extractUserUtteranceFromInternalSlugPrompt(raw: string): string | null {
  if (!INTERNAL_FILENAME_SLUG_PROMPT_RE.test(raw)) return null;
  const norm = raw.replace(/\r\n/g, "\n");
  // `[Weekday …]` 또는 긴 타임스탬프 접두 뒤의 한 줄 — 내부 요약의 "실제 유저 한마디"
  const re = /^\[[^\]]{8,}\]\s*([^\n]+)$/gm;
  const candidates: string[] = [];
  let m: RegExpExecArray | null;
  const r = new RegExp(re.source, re.flags);
  while ((m = r.exec(norm)) !== null) {
    const line = (m[1] ?? "").trim();
    if (line) candidates.push(line);
  }
  const noise = (s: string) =>
    /^assistant\s*:/i.test(s) ||
    /^user\s*:/i.test(s) ||
    /Reply with ONLY the slug/i.test(s) ||
    /Conversation summary/i.test(s) ||
    /^Based on this conversation/i.test(s);

  for (const line of candidates) {
    if (line.length > 4000) continue;
    if (noise(line)) continue;
    return line;
  }
  return null;
}

/** 채팅 말풍선에 쓸 사용자 텍스트(내부 프롬프트는 한 줄로 축약). */
export function normalizeUserChatDisplay(raw: string): string {
  const extracted = extractUserUtteranceFromInternalSlugPrompt(raw);
  if (extracted) return stripUserBubbleDecorations(extracted);
  return stripUserBubbleDecorations(raw);
}
