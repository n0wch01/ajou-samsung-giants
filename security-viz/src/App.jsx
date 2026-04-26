import { useState, useMemo } from 'react'
import { useOpenClawWS } from './hooks/useOpenClawWS'
import { detect } from './utils/detector'
import GatewayPanel from './components/GatewayPanel'
import ScenarioHeader from './components/ScenarioHeader'
import FindingsList from './components/FindingsList'
import ChatPanel from './components/ChatPanel'

const DEFAULT_WS = 'ws://127.0.0.1:18789'

export default function App() {
  const [wsUrl, setWsUrl] = useState(DEFAULT_WS)
  const [token, setToken] = useState('')
  // 채팅에서 직접 탐지된 findings (WS 경유 없이)
  const [chatFindings, setChatFindings] = useState([])

  const { status, events, connect, disconnect } = useOpenClawWS(wsUrl, token)

  // WS 이벤트에서 findings 추출
  const wsFindings = useMemo(() => {
    return events.flatMap(ev => {
      return detect(ev).map(f => ({ ...f, ts: ev._ts, eventType: ev.type, source: 'ws' }))
    })
  }, [events])

  // 채팅 findings에 source 태그
  const allFindings = useMemo(() => [
    ...wsFindings,
    ...chatFindings.map(f => ({ ...f, source: 'chat' })),
  ], [wsFindings, chatFindings])

  const latestSession = useMemo(() => {
    const msgEvent   = events.find(e => ['session.message', 'message', 'assistant_message'].includes(e.type))
    const toolEvent  = events.find(e => e.type === 'session.tool')
    const promptEvent = events.find(e => ['session.input', 'user_message'].includes(e.type))
    return { msgEvent, toolEvent, promptEvent }
  }, [events])

  const handleChatFindings = (findings, responseText) => {
    const ts = Date.now() / 1000
    setChatFindings(prev => [
      ...prev,
      ...findings.map(f => ({ ...f, ts, eventType: 'chat.response' })),
    ])
  }

  return (
    <div style={styles.root}>
      {/* 헤더 */}
      <header style={styles.header}>
        <div style={styles.logo}>🦞 <span style={styles.logoText}>ClawWatch</span></div>
        <nav style={styles.nav}>
          <span style={styles.navActive}>S2 · Data Leakage</span>
        </nav>
      </header>

      <div style={styles.body}>
        {/* 왼쪽 사이드바 */}
        <GatewayPanel findingCount={allFindings.length} />

        {/* 메인 */}
        <main style={styles.main}>
          <ScenarioHeader findingCount={allFindings.length} />

          {/* 중단: 채팅 */}
          <div style={styles.mid}>
            <div style={styles.chatCol}>
              <ChatPanel onFindings={handleChatFindings} />
            </div>
          </div>

          {/* 하단: findings + 이벤트 로그 */}
          <div style={styles.bottom}>
            <FindingsList findings={allFindings} events={events} />
          </div>
        </main>
      </div>
    </div>
  )
}

const styles = {
  root: { display: 'flex', flexDirection: 'column', height: '100vh' },
  header: {
    display: 'flex', alignItems: 'center', gap: 24,
    padding: '0 20px', height: 48,
    background: '#161b22', borderBottom: '1px solid #30363d', flexShrink: 0,
  },
  logo: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 18 },
  logoText: { fontWeight: 700, color: '#ff6b6b', letterSpacing: '-0.5px' },
  nav: { display: 'flex', gap: 16 },
  navActive: { color: '#58a6ff', fontWeight: 600, fontSize: 13 },
  body: { display: 'flex', flex: 1, overflow: 'hidden' },
  main: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 16, gap: 12 },
  mid: { display: 'flex', gap: 12, flex: 1, overflow: 'hidden' },
  chatCol: { flex: 1, overflow: 'hidden' },
  bottom: { flex: 1, overflow: 'hidden' },
}
