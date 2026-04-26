export default function ScenarioHeader({ findingCount }) {
  const hasFinding = findingCount > 0
  return (
    <div style={styles.wrapper}>
      <div style={styles.left}>
        <span style={styles.tag}>S2</span>
        <div>
          <div style={styles.title}>Data Leakage</div>
          <div style={styles.sub}>SOUL.md / CLAUDE.md 컨텍스트 인젝션 → .env 민감정보 노출 탐지</div>
        </div>
      </div>
      {hasFinding && (
        <div style={styles.alert}>
          🚨 CRITICAL — {findingCount}건 탐지
        </div>
      )}
    </div>
  )
}

const styles = {
  wrapper: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    background: '#161b22', border: '1px solid #30363d',
    borderRadius: 8, padding: '12px 16px',
  },
  left: { display: 'flex', alignItems: 'center', gap: 12 },
  tag: {
    background: '#1f6feb', color: '#fff', fontWeight: 700,
    fontSize: 12, padding: '2px 8px', borderRadius: 4,
  },
  title: { fontWeight: 700, fontSize: 15, color: '#e6edf3' },
  sub: { fontSize: 11, color: '#8b949e', marginTop: 2 },
  alert: {
    background: '#f851491a', border: '1px solid #f85149',
    borderRadius: 6, padding: '6px 12px',
    color: '#f85149', fontWeight: 700, fontSize: 12,
  },
}
