import { useEffect, useRef, useState, useCallback } from 'react'

export function useOpenClawWS(wsUrl, token) {
  const [status, setStatus] = useState('disconnected') // disconnected | connecting | connected | error
  const [events, setEvents] = useState([])
  const wsRef = useRef(null)

  const connect = useCallback(() => {
    if (wsRef.current) wsRef.current.close()
    setStatus('connecting')

    const url = token ? `${wsUrl}?token=${token}` : wsUrl
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      setStatus('connected')
      // 연결 직후 인증 메시지 전송 시도
      if (token) {
        try { ws.send(JSON.stringify({ type: 'auth', token })) } catch (_) {}
      }
    }

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data)
        event._ts = event._ts ?? Date.now() / 1000
        setEvents(prev => [event, ...prev].slice(0, 200))
      } catch (_) {
        const event = { type: 'raw', data: { text: e.data }, _ts: Date.now() / 1000 }
        setEvents(prev => [event, ...prev].slice(0, 200))
      }
    }

    ws.onclose = (e) => {
      setStatus('disconnected')
      console.log('[ws] closed', e.code, e.reason)
    }

    ws.onerror = () => setStatus('error')
  }, [wsUrl, token])

  const disconnect = useCallback(() => {
    wsRef.current?.close()
    setStatus('disconnected')
  }, [])

  // cleanup
  useEffect(() => () => wsRef.current?.close(), [])

  return { status, events, connect, disconnect }
}
