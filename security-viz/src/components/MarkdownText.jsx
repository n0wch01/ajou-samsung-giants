// 외부 라이브러리 없이 기본 마크다운 렌더링
export default function MarkdownText({ text }) {
  if (!text) return null

  const lines = text.split('\n')
  const elements = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // 코드블록
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim()
      const codeLines = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      elements.push(
        <pre key={i} style={s.pre}>
          {lang && <div style={s.lang}>{lang}</div>}
          <code>{codeLines.join('\n')}</code>
        </pre>
      )
      i++
      continue
    }

    // 구분선
    if (/^---+$/.test(line.trim())) {
      elements.push(<hr key={i} style={s.hr} />)
      i++
      continue
    }

    // 빈 줄
    if (!line.trim()) {
      elements.push(<div key={i} style={{ height: 6 }} />)
      i++
      continue
    }

    // 일반 텍스트 (인라인 마크다운 처리)
    elements.push(
      <div key={i} style={s.line}>
        {renderInline(line)}
      </div>
    )
    i++
  }

  return <div style={s.root}>{elements}</div>
}

function renderInline(text) {
  // **bold**, `code`, 일반 텍스트를 분리
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/)
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={i} style={s.inlineCode}>{part.slice(1, -1)}</code>
    }
    // 리스트 아이템 (- 또는 숫자.)
    if (/^[-*]\s/.test(part)) {
      return <span key={i}>{'• ' + part.slice(2)}</span>
    }
    if (/^\d+\.\s/.test(part)) {
      return <span key={i}>{part}</span>
    }
    return part
  })
}

const s = {
  root: { fontSize: 13, color: '#e6edf3', lineHeight: 1.6 },
  line: { marginBottom: 2 },
  pre: {
    background: '#0d1117', border: '1px solid #30363d', borderRadius: 6,
    padding: '10px 12px', margin: '6px 0', overflowX: 'auto',
    fontFamily: 'monospace', fontSize: 12, color: '#e6edf3',
    position: 'relative',
  },
  lang: { fontSize: 10, color: '#8b949e', marginBottom: 4 },
  inlineCode: {
    background: '#21262d', border: '1px solid #30363d', borderRadius: 4,
    padding: '1px 5px', fontFamily: 'monospace', fontSize: 12, color: '#f0883e',
  },
  hr: { border: 'none', borderTop: '1px solid #30363d', margin: '8px 0' },
}
