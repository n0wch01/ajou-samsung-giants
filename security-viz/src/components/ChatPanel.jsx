import { useState, useEffect, useRef } from 'react'
import { detect } from '../utils/detector'
import MarkdownText from './MarkdownText'

const BRIDGE = 'http://localhost:8000'
const SEV_COLOR = { CRITICAL: '#f85149', HIGH: '#d29922', MEDIUM: '#58a6ff' }

export default function ChatPanel({ onFindings }) {
  const [prompt, setPrompt] = useState('')
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(false)
  const [presets, setPresets] = useState([])
  const [bridgeOk, setBridgeOk] = useState(false)
  const bottomRef = useRef(null)

  // 브릿지 헬스체크 + 프리셋 로드
  useEffect(() => {
    fetch(`${BRIDGE}/health`)
      .then(r => r.ok && setBridgeOk(true))
      .catch(() => setBridgeOk(false))

    fetch(`${BRIDGE}/presets`)
      .then(r => r.json())
      .then(d => setPresets(d.presets ?? []))
      .catch(() => {})
  }, [])

  // 새 메시지 시 스크롤
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const send = async (text) => {
    const p = (text ?? prompt).trim()
    if (!p || loading) return

    setMessages(prev => [...prev, { role: 'user', text: p }])
    setPrompt('')
    setLoading(true)

    try {
      const res = await fetch(`${BRIDGE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: p }),
      })
      const data = await res.json()

      const responseText = data.response || data.error || '(응답 없음)'
      const meta = data.meta ?? {}

      // 탐지 실행
      const fakeEvent = { type: 'session.message', data: { content: responseText } }
      const findings = detect(fakeEvent)
      if (findings.length > 0) onFindings?.(findings, responseText)

      setMessages(prev => [...prev, {
        role: 'assistant',
        text: responseText,
        findings,
        meta,
        isError: !!data.error && !data.response,
      }])
    } catch (e) {
      setMessages(prev => [...prev, { role: 'error', text: `브릿지 연결 실패: ${e.message}` }])
    } finally {
      setLoading(false)
    }
  }

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  return (
    <div style={styles.wrapper}>
      {/* 헤더 */}
      <div style={styles.header}>
        <span style={styles.title}>공격 채팅</span>
        <span style={{ ...styles.badge, background: bridgeOk ? '#3fb95022' : '#f8514922', color: bridgeOk ? '#3fb950' : '#f85149', border: `1px solid ${bridgeOk ? '#3fb95055' : '#f8514955'}` }}>
          {bridgeOk ? 'Bridge Connected' : 'Bridge Offline'}
        </span>
      </div>

      {/* 프리셋 버튼 */}
      {presets.length > 0 && (
        <div style={styles.presets}>
          {presets.map(p => (
            <button key={p.id} style={styles.presetBtn} onClick={() => send(p.prompt)} title={p.desc}>
              {p.label}
            </button>
          ))}
        </div>
      )}

      {/* 메시지 목록 */}
      <div style={styles.messages}>
        {messages.length === 0 && (
          <div style={styles.empty}>위 프리셋 버튼을 클릭하거나 직접 프롬프트를 입력하세요.</div>
        )}
        {messages.map((msg, i) => (
          <div key={i} style={{ ...styles.msg, ...(msg.role === 'user' ? styles.msgUser : styles.msgAI) }}>
            <div style={styles.msgRole}>{msg.role === 'user' ? '사용자' : msg.role === 'error' ? '오류' : 'OpenClaw AI'}</div>
            <div style={styles.msgBody}>
              {msg.role === 'assistant'
                ? <MarkdownText text={msg.text} />
                : <div style={styles.msgText}>{msg.text}</div>
              }
            </div>
            {msg.findings?.length > 0 && (
              <div style={styles.findingInline}>
                🚨 민감정보 탐지 — {msg.findings.length}건
                {msg.findings.map((f, j) => (
                  <div key={j} style={{ ...styles.findingItem, color: SEV_COLOR[f.severity] }}>
                    [{f.severity}] {f.label}: {f.snippet}
                  </div>
                ))}
              </div>
            )}
            {msg.meta?.injectedFiles?.length > 0 && (
              <div style={styles.metaBox}>
                <div style={styles.metaTitle}>📂 주입된 워크스페이스 파일</div>
                {msg.meta.injectedFiles.map((f, j) => (
                  <div key={j} style={{ ...styles.metaItem, color: f.name === 'SOUL.md' ? '#d29922' : '#8b949e' }}>
                    {f.truncated ? '⚠' : '✓'} {f.name} ({f.chars}자)
                    {f.name === 'SOUL.md' && ' ← 공격 파일'}
                    {f.name === 'AGENTS.md' && ' ← 핵심 공격 벡터'}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {loading && (
          <div style={{ ...styles.msg, ...styles.msgAI }}>
            <div style={styles.msgRole}>OpenClaw AI</div>
            <div style={styles.loading}>⠋ 처리 중...</div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 입력창 */}
      <div style={styles.inputRow}>
        <textarea
          style={styles.input}
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          onKeyDown={handleKey}
          placeholder="프롬프트 입력 (Enter: 전송, Shift+Enter: 줄바꿈)"
          rows={2}
          disabled={loading}
        />
        <button style={{ ...styles.sendBtn, opacity: loading || !prompt.trim() ? 0.4 : 1 }}
          onClick={() => send()} disabled={loading || !prompt.trim()}>
          전송
        </button>
      </div>
    </div>
  )
}

const styles = {
  wrapper: {
    background: '#161b22', border: '1px solid #30363d', borderRadius: 8,
    display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '10px 14px', borderBottom: '1px solid #21262d', flexShrink: 0,
  },
  title: { fontSize: 11, fontWeight: 700, color: '#8b949e', textTransform: 'uppercase', letterSpacing: 1 },
  badge: { fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 10 },
  presets: {
    display: 'flex', gap: 6, padding: '8px 12px', flexWrap: 'wrap',
    borderBottom: '1px solid #21262d', flexShrink: 0,
  },
  presetBtn: {
    background: '#1f6feb22', border: '1px solid #1f6feb55', borderRadius: 6,
    color: '#58a6ff', fontSize: 11, padding: '4px 10px', cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  messages: { flex: 1, overflowY: 'scroll', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 },
  empty: { color: '#6e7681', fontSize: 12, textAlign: 'center', padding: '20px 0' },
  msg: { borderRadius: 8, padding: '8px 12px', maxWidth: '90%' },
  msgUser: { background: '#1f6feb22', border: '1px solid #1f6feb33', alignSelf: 'flex-end' },
  msgAI:   { background: '#0d1117', border: '1px solid #30363d', alignSelf: 'flex-start' },
  msgRole: { fontSize: 10, color: '#6e7681', marginBottom: 4, fontWeight: 600 },
  msgBody: { maxHeight: 300, overflowY: 'auto', marginBottom: 4 },
  msgText: { fontSize: 12, color: '#e6edf3', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'monospace' },
  loading: { color: '#8b949e', fontSize: 12, fontStyle: 'italic' },
  findingInline: {
    marginTop: 8, background: '#f851491a', border: '1px solid #f8514955',
    borderRadius: 6, padding: '6px 8px', fontSize: 11, color: '#f85149', fontWeight: 600,
    maxHeight: 160, overflowY: 'auto',
  },
  findingItem: { fontFamily: 'monospace', fontSize: 10, marginTop: 2, wordBreak: 'break-all' },
  metaBox: {
    marginTop: 6, background: '#21262d', border: '1px solid #30363d',
    borderRadius: 6, padding: '6px 8px', fontSize: 10,
  },
  metaTitle: { color: '#8b949e', fontWeight: 600, marginBottom: 4 },
  metaItem: { fontFamily: 'monospace', marginTop: 2 },
  inputRow: {
    display: 'flex', gap: 8, padding: '10px 12px',
    borderTop: '1px solid #21262d', flexShrink: 0,
  },
  input: {
    flex: 1, background: '#0d1117', border: '1px solid #30363d', borderRadius: 6,
    color: '#e6edf3', padding: '7px 10px', fontSize: 12, resize: 'none',
    outline: 'none', fontFamily: 'inherit',
  },
  sendBtn: {
    background: '#238636', border: 'none', borderRadius: 6,
    color: '#fff', padding: '0 16px', fontSize: 12, fontWeight: 600,
    cursor: 'pointer', flexShrink: 0,
  },
}
