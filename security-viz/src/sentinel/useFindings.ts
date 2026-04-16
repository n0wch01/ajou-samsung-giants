import { useCallback, useEffect, useRef, useState } from "react";

export type SentinelSeverity = "info" | "low" | "medium" | "high" | "critical";

export type SentinelFinding = {
  id: string;
  ruleId: string;
  severity: SentinelSeverity;
  title: string;
  message: string;
  recommendedAction: string;
  timestamp?: string;
};

function normalizeFindings(body: unknown): SentinelFinding[] {
  if (Array.isArray(body)) return body as SentinelFinding[];
  if (body && typeof body === "object") {
    const f = (body as { findings?: unknown }).findings;
    if (Array.isArray(f)) return f as SentinelFinding[];
  }
  return [];
}

function findingsUrl(): string {
  const explicit = import.meta.env.VITE_SENTINEL_API_BASE;
  if (explicit) return `${explicit.replace(/\/$/, "")}/findings`;
  if (import.meta.env.DEV) return "/sentinel-api/findings";
  return "/findings";
}

function sseUrl(): string {
  const explicit = import.meta.env.VITE_SENTINEL_API_BASE;
  if (explicit) return `${explicit.replace(/\/$/, "")}/findings/stream`;
  const fromEnv = import.meta.env.VITE_SENTINEL_SSE;
  if (fromEnv) return fromEnv;
  if (import.meta.env.DEV) return "/sentinel-api/findings/stream";
  return "/findings/stream";
}

export function useFindings(opts: { pollMs: number; useSse: boolean }) {
  const [findings, setFindings] = useState<SentinelFinding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  const pull = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(findingsUrl(), { headers: { Accept: "application/json" } });
      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}`);
      }
      const data: unknown = await res.json();
      setFindings(normalizeFindings(data));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void pull();
  }, [pull]);

  useEffect(() => {
    if (!opts.useSse) {
      esRef.current?.close();
      esRef.current = null;
      return;
    }
    const url = sseUrl();
    let es: EventSource;
    try {
      es = new EventSource(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "EventSource not available");
      return;
    }
    esRef.current = es;
    es.onmessage = (ev) => {
      try {
        const parsed: unknown = JSON.parse(ev.data);
        const next = normalizeFindings(parsed);
        if (next.length === 0 && parsed && typeof parsed === "object") {
          const one = parsed as SentinelFinding;
          if (typeof one.ruleId === "string" && typeof one.id === "string") {
            setFindings((prev) => {
              const merged = [...prev.filter((p) => p.id !== one.id), one];
              return merged;
            });
            return;
          }
        }
        if (next.length) setFindings((prev) => mergeById(prev, next));
      } catch {
        /* ignore malformed sse */
      }
    };
    es.onerror = () => {
      setError((prev) => prev ?? "SSE connection error (is the Sentinel HTTP service running?)");
    };
    return () => {
      es.close();
      if (esRef.current === es) esRef.current = null;
    };
  }, [opts.useSse]);

  useEffect(() => {
    if (opts.useSse) return;
    const t = window.setInterval(() => void pull(), opts.pollMs);
    return () => window.clearInterval(t);
  }, [opts.pollMs, opts.useSse, pull]);

  return { findings, error, loading, refresh: pull };
}

function mergeById(prev: SentinelFinding[], next: SentinelFinding[]): SentinelFinding[] {
  const map = new Map<string, SentinelFinding>();
  for (const p of prev) map.set(p.id, p);
  for (const n of next) map.set(n.id, n);
  return [...map.values()].sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));
}
