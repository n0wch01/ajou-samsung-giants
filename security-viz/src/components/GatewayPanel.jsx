export default function GatewayPanel({ findingCount }) {
  return (
    <aside style={styles.panel}>
      <section style={styles.section}>
        <div style={styles.sectionTitle}>Sentinel 수집</div>
        <div style={styles.stat}>
          <span style={styles.statLabel}>탐지 건수</span>
          <span style={{ ...styles.statValue, color: findingCount > 0 ? '#f85149' : '#3fb950' }}>
            {findingCount}
          </span>
        </div>
      </section>

      <section style={styles.section}>
        <div style={styles.sectionTitle}>시나리오</div>
        <div style={styles.scenarioBadge}>S2 · Data Leakage</div>
      </section>
    </aside>
  )
}

const styles = {
  panel: {
    width: 180, flexShrink: 0,
    background: '#161b22',
    borderRight: '1px solid #30363d',
    overflowY: 'auto',
    padding: '12px 0',
  },
  section: {
    padding: '12px 16px',
    borderBottom: '1px solid #21262d',
  },
  sectionTitle: {
    fontSize: 11, fontWeight: 700, color: '#8b949e',
    textTransform: 'uppercase', letterSpacing: 1,
    marginBottom: 10,
  },
  stat: { display: 'flex', justifyContent: 'space-between', marginBottom: 6 },
  statLabel: { color: '#8b949e', fontSize: 12 },
  statValue: { fontWeight: 700, fontFamily: 'monospace' },
  scenarioBadge: {
    fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 4,
    background: '#1f6feb22', color: '#58a6ff',
    border: '1px solid #1f6feb55',
  },
}
