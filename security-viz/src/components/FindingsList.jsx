const SEV_COLOR = { CRITICAL: '#f85149', HIGH: '#d29922', MEDIUM: '#58a6ff' }

export default function FindingsList({ findings, events }) {
  return (
    <div style={styles.wrapper}>
      <div style={styles.header}>
        <span style={styles.title}>탐지 결과</span>
        <span style={styles.count}>{findings.length}건</span>
      </div>

      <div style={styles.cols}>
        {/* 왼쪽: findings */}
        <div style={styles.col}>
          <div style={styles.colTitle}>Findings</div>
          {findings.length === 0 ? (
            <div style={styles.empty}>탐지된 항목 없음</div>
          ) : (
            findings.map((f, i) => (
              <div key={i} style={styles.finding}>
                <span style={{ ...styles.sev, background: SEV_COLOR[f.severity] + '22', color: SEV_COLOR[f.severity], border: `1px solid ${SEV_COLOR[f.severity]}55` }}>
                  {f.severity}
                </span>
                <div style={styles.findingLabel}>{f.label}</div>
                <div style={styles.findingSnippet}>{f.snippet}</div>
                <div style={styles.findingMeta}>{f.eventType} · {new Date(f.ts * 1000).toLocaleTimeString('ko-KR')}</div>
              </div>
            ))
          )}
        </div>

        {/* 오른쪽: 원시 이벤트 로그 */}
        <div style={styles.col}>
          <div style={styles.colTitle}>이벤트 로그 (최근 {events.length}개)</div>
          <div style={styles.logBox}>
            {events.length === 0 ? (
              <div style={styles.empty}>수신된 이벤트 없음</div>
            ) : (
              events.map((ev, i) => (
                <div key={i} style={styles.logEntry}>
                  <span style={styles.logType}>{ev.type ?? 'raw'}</span>
                  <span style={styles.logTime}>{new Date(ev._ts * 1000).toLocaleTimeString('ko-KR')}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

const styles = {
  wrapper: {
    background: '#161b22', border: '1px solid #30363d',
    borderRadius: 8, padding: '12px 16px',
    display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden',
  },
  header: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 },
  title: { fontSize: 11, fontWeight: 700, color: '#8b949e', textTransform: 'uppercase', letterSpacing: 1 },
  count: {
    background: '#f851491a', color: '#f85149', border: '1px solid #f8514955',
    borderRadius: 10, padding: '0 7px', fontSize: 11, fontWeight: 700,
  },
  cols: { display: 'flex', gap: 12, flex: 1, overflow: 'hidden' },
  col: { flex: 1, display: 'flex', flexDirection: 'column', overflowY: 'auto' },
  colTitle: { fontSize: 11, color: '#8b949e', marginBottom: 8 },
  empty: { color: '#8b949e', fontSize: 12, padding: '8px 0' },
  finding: {
    background: '#0d1117', border: '1px solid #30363d', borderRadius: 6,
    padding: '8px 10px', marginBottom: 6,
  },
  sev: {
    display: 'inline-block', fontSize: 10, fontWeight: 700,
    padding: '1px 6px', borderRadius: 4, marginBottom: 4,
  },
  findingLabel: { fontSize: 12, fontWeight: 600, color: '#e6edf3', marginBottom: 2 },
  findingSnippet: { fontSize: 11, fontFamily: 'monospace', color: '#f85149', wordBreak: 'break-all', marginBottom: 2 },
  findingMeta: { fontSize: 10, color: '#6e7681' },
  logBox: { flex: 1, overflowY: 'auto', background: '#0d1117', border: '1px solid #21262d', borderRadius: 6, padding: '6px 8px' },
  logEntry: { display: 'flex', justifyContent: 'space-between', padding: '2px 0', borderBottom: '1px solid #21262d' },
  logType: { fontFamily: 'monospace', fontSize: 11, color: '#58a6ff' },
  logTime: { fontSize: 10, color: '#6e7681' },
}
