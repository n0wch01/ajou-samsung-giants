import type { ReactNode } from "react";

/**
 * Docs 본문 작성용 재사용 프리미티브.
 * 모든 Docs 하위 탭(Chat/Monitoring/Policy/Test Scenario)에서 공통으로 쓴다.
 */

/** 섹션 도입부 한두 문장 (살짝 큰 글씨). */
export function DocLede({ children }: { children: ReactNode }) {
  return <p className="docs-lede">{children}</p>;
}

/** 제목이 있는 본문 블록. */
export function DocBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="docs-block">
      <h3 className="docs-block-title">{title}</h3>
      {children}
    </section>
  );
}

/** 본문 문단. */
export function DocP({ children }: { children: ReactNode }) {
  return <p className="docs-p">{children}</p>;
}

/** 번호 있는 단계 목록. */
export function DocSteps({ children }: { children: ReactNode }) {
  return <ol className="docs-steps">{children}</ol>;
}

export function DocStep({ children }: { children: ReactNode }) {
  return <li className="docs-step">{children}</li>;
}

/** 강조 콜아웃 (info=기본 / tip=도움말 / warn=주의). */
export function DocNote({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "tip" | "warn";
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className={`docs-note docs-note--${tone}`}>
      {title ? <span className="docs-note-title">{title}</span> : null}
      <div className="docs-note-body">{children}</div>
    </div>
  );
}

/** 인라인 코드/식별자. */
export function DocCode({ children }: { children: ReactNode }) {
  return <code className="docs-code">{children}</code>;
}

/** 용어-설명 정의 목록 (상태바 항목, 검사 카드 설명 등 레퍼런스용). */
export function DocDefList({ children }: { children: ReactNode }) {
  return <dl className="docs-deflist">{children}</dl>;
}

export function DocDef({ term, children }: { term: ReactNode; children: ReactNode }) {
  return (
    <div className="docs-def">
      <dt className="docs-def-term">{term}</dt>
      <dd className="docs-def-desc">{children}</dd>
    </div>
  );
}
