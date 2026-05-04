const STEPS = [
  { id: 'prompt',   label: '① 사용자 프롬프트', icon: '💬' },
  { id: 'llm',      label: '② LLM 처리',        icon: '🧠' },
  { id: 'detect',   label: '③ 민감정보 탐지',    icon: '🔍' },
  { id: 'response', label: '④ 에이전트 응답',    icon: '📤' },
]

export default function ExecutionFlow({ session, findings }) {
  const hasLeak = findings.length > 0
  const { msgEvent, toolEvent, promptEvent } = session

  const stepStatus = {
    prompt:   promptEvent ? 'done' : 'idle',
    llm:      msgEvent || toolEvent ? 'done' : 'idle',
    detect:   msgEvent ? (hasLeak ? 'alert' : 'done') : 'idle',
    response: msgEvent ? (hasLeak ? 'alert' : 'done') : 'idle',
  }

  const stepDetail = {
    prompt:   promptEvent ? truncate(promptEvent.data?.content ?? promptEvent.data?.text ?? '') : '대기 중...',
    llm:      msgEvent ? 'session.message 수신' : toolEvent ? 'session.tool 수신' : '대기 중...',
    detect:   hasLeak ? `${findings.length}건 탐지됨` : msgEvent ? '탐지 없음' : '대기 중...',
    response: msgEvent ? truncate(msgEvent.data?.content ?? msgEvent.data?.text ?? '') : '대기 중...',
  }

  return (
    <div style={styles.wrapper}>
      <div style={styles.title}>실행 흐름</div>
      <div style={styles.flow}>
        {STEPS.map((step, i) => {
          const s = stepStatus[step.id]
          return (
            <div key={step.id} style={styles.stepRow}>
              <div style={{ ...styles.node, ...nodeStyle(s) }}>
                <div style={styles.nodeIcon}>{step.icon}</div>
                <div style={styles.nodeLabel}>{step.label}</div>
                <div style={{ ...styles.nodeDetail, color: s === 'alert' ? '#f85149' : '#8b949e' }}>
                  {stepDetail[step.id]}
                </div>
                {s === 'alert' && <div style={styles.alertDot} />}
              </div>
              {i < STEPS.length - 1 && (
                <div style={{ ...styles.arrow, color: s === 'done' || s === 'alert' ? '#58a6ff' : '#30363d' }}>
                  →
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function truncate(str, n = 40) {
  return str.length > n ? str.slice(0, n) + '…' : str
}

function nodeStyle(status) {
  if (status === 'alert') return { borderColor: '#f85149', background: '#f851491a' }
  if (status === 'done')  return { borderColor: '#3fb950', background: '#3fb9501a' }
  return {}
}

const styles = {
  wrapper: {
    background: '#161b22', border: '1px solid #30363d',
    borderRadius: 8, padding: '12px 16px',
  },
  title: { fontSize: 11, fontWeight: 700, color: '#8b949e', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 },
  flow: { display: 'flex', alignItems: 'center', gap: 0, overflowX: 'auto' },
  stepRow: { display: 'flex', alignItems: 'center' },
  node: {
    position: 'relative',
    background: '#0d1117', border: '1px solid #30363d',
    borderRadius: 8, padding: '10px 14px', minWidth: 160,
    flexShrink: 0,
  },
  nodeIcon: { fontSize: 16, marginBottom: 4 },
  nodeLabel: { fontSize: 11, fontWeight: 600, color: '#e6edf3', marginBottom: 4 },
  nodeDetail: { fontSize: 10, fontFamily: 'monospace', wordBreak: 'break-all' },
  arrow: { fontSize: 20, padding: '0 8px', flexShrink: 0 },
  alertDot: {
    position: 'absolute', top: 6, right: 6,
    width: 8, height: 8, borderRadius: '50%', background: '#f85149',
  },
}
