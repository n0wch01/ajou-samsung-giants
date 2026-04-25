import argparse
import html
import json
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
SCENARIOS_DIR = REPO_ROOT / "scenarios"
DEFAULT_OUT = REPO_ROOT / "dashboard" / "out" / "index.html"


def load_json(path: Path, fallback: Any) -> Any:
    if not path.exists():
        return fallback
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return fallback


def escape(value: Any) -> str:
    return html.escape(str(value))


def badge(text: str, tone: str) -> str:
    return f'<span class="badge {tone}">{escape(text)}</span>'


def scenario_files() -> list[Path]:
    return sorted(SCENARIOS_DIR.glob("*/scenario.json"))


def plugin_tool_ids(tools: Any) -> list[str]:
    if not isinstance(tools, list):
        return []
    return sorted(tool["id"] for tool in tools if isinstance(tool, dict) and isinstance(tool.get("id"), str))


def catalog_tool_ids(catalog: Any) -> list[str]:
    if not isinstance(catalog, dict):
        return []

    ids: list[str] = []
    for group in catalog.get("groups", []):
        if not isinstance(group, dict):
            continue
        for tool in group.get("tools", []):
            if isinstance(tool, dict) and isinstance(tool.get("id"), str):
                ids.append(tool["id"])
    return sorted(set(ids))


def analyze_artifacts(scenario: dict[str, Any], scenario_dir: Path) -> dict[str, Any]:
    artifact_dir = scenario_dir / "artifacts"
    kind = scenario.get("artifactType")

    if kind != "plugin-catalog-diff":
        return {
            "status": "planned",
            "statusLabel": "준비 중",
            "summary": "아직 실행기가 연결되지 않은 시나리오입니다.",
            "metrics": [],
            "evidence": [],
        }

    before_catalog = load_json(
        artifact_dir / "catalog_before_install.json",
        load_json(artifact_dir / "catalog_before.json", {}),
    )
    after_catalog = load_json(artifact_dir / "catalog_after_install.json", before_catalog)
    before_tools = catalog_tool_ids(before_catalog)
    after_tools = catalog_tool_ids(after_catalog)
    added_tools = load_json(artifact_dir / "plugin_tools_added.json", [])
    added_tools = sorted(tool for tool in added_tools if isinstance(tool, str))
    install_ran = (artifact_dir / "plugin_tools_added.json").exists()

    if added_tools:
        status = "danger"
        status_label = "위험 감지"
        summary = "설치 전에는 없던 플러그인 도구가 설치 후 catalog에 나타났습니다."
    elif install_ran:
        status = "clear"
        status_label = "변화 없음"
        summary = "실행은 완료됐지만 새 플러그인 도구는 발견되지 않았습니다."
    else:
        status = "not-run"
        status_label = "미실행"
        summary = "아직 artifact가 없습니다. 실행 후 결과가 이 화면에 반영됩니다."

    return {
        "status": status,
        "statusLabel": status_label,
        "summary": summary,
        "metrics": [
            ("설치 전 전체 도구", len(before_tools)),
            ("설치 후 전체 도구", len(after_tools)),
            ("새로 추가된 도구", len(added_tools)),
        ],
        "evidence": added_tools,
        "beforeTools": before_tools,
        "afterTools": after_tools,
    }


def load_scenarios() -> list[dict[str, Any]]:
    scenarios = []
    for path in scenario_files():
        data = load_json(path, {})
        if not isinstance(data, dict):
            continue
        scenario_dir = path.parent
        data["_dir"] = scenario_dir
        data["_analysis"] = analyze_artifacts(data, scenario_dir)
        scenarios.append(data)
    return sorted(scenarios, key=lambda item: item.get("id", ""))


def render_scenario_card(scenario: dict[str, Any]) -> str:
    analysis = scenario["_analysis"]
    scenario_id = escape(scenario.get("id", "?"))
    tone = {
        "danger": "danger",
        "clear": "ok",
        "not-run": "warn",
        "planned": "muted-badge",
    }.get(analysis["status"], "warn")
    return f"""
      <button class="scenario-card" type="button" data-scenario-card="{scenario_id}">
        <div class="card-top">
          <strong>{scenario_id}</strong>
          {badge(analysis["statusLabel"], tone)}
        </div>
        <h3>{escape(scenario.get("title", "Untitled scenario"))}</h3>
        <p>{escape(scenario.get("description", ""))}</p>
        <div class="mini-grid">
          <span>대상</span><strong>{escape(scenario.get("target", "OpenClaw"))}</strong>
        </div>
      </button>
    """


def render_chat(scenario: dict[str, Any]) -> str:
    chat = scenario.get("conversation", [])
    if not isinstance(chat, list) or not chat:
        return '<p class="muted">아직 대화 예시가 등록되지 않았습니다.</p>'

    rows = []
    for item in chat:
        if not isinstance(item, dict):
            continue
        role = item.get("role", "system")
        label = item.get("label", role)
        message = item.get("message", "")
        rows.append(
            f"""
            <div class="chat-row {escape(role)}">
              <div class="avatar">{escape(label)}</div>
              <div class="bubble">{escape(message)}</div>
            </div>
            """
        )
    return '<div class="chat-box">' + "".join(rows) + "</div>"


def render_flow(scenario: dict[str, Any]) -> str:
    steps = scenario.get("flow", [])
    if not isinstance(steps, list) or not steps:
        return '<p class="muted">아직 실행 흐름이 등록되지 않았습니다.</p>'

    parts = []
    for index, step in enumerate(steps, start=1):
        if not isinstance(step, dict):
            continue
        parts.append(
            f"""
            <div class="flow-step">
              <div class="step-no">{index}</div>
              <div>
                <h4>{escape(step.get("title", ""))}</h4>
                <p>{escape(step.get("description", ""))}</p>
              </div>
            </div>
            """
        )
    return '<div class="flow-box">' + "".join(parts) + "</div>"


def render_tool_list(title: str, tools: list[str], highlight: set[str] | None = None) -> str:
    highlight = highlight or set()
    if not tools:
        body = '<div class="empty">표시할 도구가 없습니다.</div>'
    else:
        body = "".join(
            f'<div class="tool-item {"hot" if tool in highlight else ""}"><code>{escape(tool)}</code>{"<span>새로 등장</span>" if tool in highlight else ""}</div>'
            for tool in tools
        )
    return f"""
      <div class="tool-panel">
        <h4>{escape(title)}</h4>
        {body}
      </div>
    """


def render_selected_scenario(scenario: dict[str, Any]) -> str:
    analysis = scenario["_analysis"]
    raw_scenario_id = str(scenario.get("id", "?"))
    scenario_id = escape(raw_scenario_id)
    evidence = analysis.get("evidence", [])
    before_tools = analysis.get("beforeTools", [])
    after_tools = analysis.get("afterTools", [])
    evidence_set = set(evidence)
    show_s1_runtime = raw_scenario_id == "S1"

    metrics = "".join(
        f'<div class="metric"><span>{escape(name)}</span><strong>{escape(value)}</strong></div>'
        for name, value in analysis.get("metrics", [])
    )

    prompt_panel = (
        f"""
        <article class="panel live-chat">
          <div>
            <h3>프롬프트</h3>
          </div>
          <form id="chatForm" class="chat-form">
            <input id="chatInput" name="message" autocomplete="off" />
            <button type="submit">OpenClaw에게 보내기</button>
          </form>
          <div class="chat-thread">
            <div class="dm-row assistant">
              <div class="dm-avatar">OC</div>
              <div class="dm-bubble">프롬프트를 입력하면 OpenClaw의 응답이 여기에 표시됩니다.</div>
            </div>
          </div>
        </article>
        """
        if show_s1_runtime
        else ""
    )

    result_panel = (
        f"""
        <article class="panel">
          <h3>관찰 결과</h3>
          {metrics or '<p class="muted">아직 수집된 지표가 없습니다.</p>'}
        </article>
        """
        if show_s1_runtime
        else '<article class="panel"><h3>준비 중</h3><p class="muted">이 시나리오는 아직 실행기가 연결되지 않았습니다.</p></article>'
    )

    tools_panel = (
        f"""
        <article class="panel">
          <h3>설치 전 / 설치 후 도구 변화</h3>
          <div class="compare">
            {render_tool_list("설치 전 catalog", before_tools)}
            <div class="arrow">→</div>
            {render_tool_list("설치 후 catalog", after_tools, evidence_set)}
          </div>
        </article>
        """
        if show_s1_runtime
        else ""
    )

    return f"""
      <section class="detail" data-scenario-detail="{scenario_id}">
        <div class="detail-header">
          <div>
            <p class="eyebrow">선택된 시나리오</p>
            <h2>{escape(scenario.get("title", ""))}</h2>
          </div>
          {badge(analysis["statusLabel"], "danger" if analysis["status"] == "danger" else "warn")}
        </div>

        {prompt_panel}
        {result_panel}
        {tools_panel}
      </section>
    """


def build_report() -> str:
    scenarios = load_scenarios()

    scenario_cards = "".join(render_scenario_card(scenario) for scenario in scenarios)
    scenario_details = "".join(render_selected_scenario(scenario) for scenario in scenarios)
    selected_html = scenario_details or '<section class="panel">등록된 시나리오가 없습니다.</section>'

    return f"""<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AI AGENT Security</title>
  <style>
    :root {{
      color-scheme: dark;
      --bg: #0d1630;
      --panel: rgba(255, 255, 255, 0.1);
      --panel2: rgba(255, 255, 255, 0.16);
      --text: #fbfdff;
      --muted: #c8d7ea;
      --line: rgba(255, 255, 255, 0.2);
      --blue: #74d5ff;
      --red: #ff6b8a;
      --yellow: #ffe08a;
      --green: #54e6a1;
      --purple: #a78bfa;
      --pink: #fb7185;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      color: var(--text);
      background:
        radial-gradient(circle at 12% 8%, rgba(116, 213, 255, 0.42), transparent 28%),
        radial-gradient(circle at 78% 0%, rgba(167, 139, 250, 0.38), transparent 30%),
        radial-gradient(circle at 80% 82%, rgba(251, 113, 133, 0.28), transparent 34%),
        linear-gradient(135deg, #10254d 0%, #16224a 46%, #24163f 100%);
      background-attachment: fixed;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }}
    header {{
      padding: 28px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.18);
      background: linear-gradient(135deg, rgba(255, 255, 255, 0.16), rgba(255, 255, 255, 0.05));
      backdrop-filter: blur(18px);
    }}
    h1, h2, h3, h4, p {{ margin-top: 0; }}
    h1 {{
      margin-bottom: 10px;
      font-size: clamp(34px, 5vw, 64px);
      letter-spacing: -0.05em;
      line-height: 1;
    }}
    main {{
      display: grid;
      gap: 18px;
      padding: 18px;
    }}
    .eyebrow {{
      color: var(--blue);
      font-weight: 800;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }}
    .muted {{ color: var(--muted); }}
    .summary-card, .panel, .scenario-card, .detail {{
      border: 1px solid var(--line);
      background: linear-gradient(145deg, rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0.07));
      border-radius: 18px;
      box-shadow: 0 24px 80px rgba(7, 12, 30, 0.24);
      backdrop-filter: blur(18px);
    }}
    .scenario-grid {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 12px;
    }}
    .scenario-card {{
      padding: 16px;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
      transition: border-color 120ms ease, transform 120ms ease, background 120ms ease;
    }}
    .scenario-card:hover,
    .scenario-card.active {{
      border-color: rgba(116, 213, 255, 0.88);
      background: linear-gradient(145deg, rgba(116, 213, 255, 0.22), rgba(167, 139, 250, 0.16));
      transform: translateY(-1px);
    }}
    .card-top, .detail-header, .metric, .tool-item {{
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
    }}
    .mini-grid {{
      display: grid;
      grid-template-columns: 72px 1fr;
      gap: 6px 12px;
      color: var(--muted);
    }}
    .mini-grid strong {{ color: var(--text); }}
    .badge {{
      display: inline-flex;
      border-radius: 999px;
      padding: 5px 10px;
      font-size: 12px;
      font-weight: 800;
    }}
    .danger {{ background: linear-gradient(135deg, var(--red), var(--pink)); color: white; }}
    .ok {{ background: var(--green); color: #05120b; }}
    .warn {{ background: var(--yellow); color: #171000; }}
    .muted-badge {{ background: rgba(255, 255, 255, 0.18); color: var(--muted); }}
    .detail {{
      padding: 18px;
    }}
    .detail[hidden] {{
      display: none;
    }}
    .detail-header {{
      margin-bottom: 18px;
      align-items: flex-start;
    }}
    .detail-header h2 {{
      font-size: 34px;
      letter-spacing: -0.03em;
    }}
    .two-col {{
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
      margin-bottom: 14px;
    }}
    .panel {{
      padding: 16px;
    }}
    .chat-box {{
      display: grid;
      gap: 12px;
    }}
    .live-chat {{
      display: grid;
      gap: 14px;
      margin-bottom: 14px;
      border-color: rgba(116, 213, 255, 0.56);
      background:
        radial-gradient(circle at 18% 0%, rgba(116, 213, 255, 0.22), transparent 34%),
        linear-gradient(145deg, rgba(255, 255, 255, 0.18), rgba(255, 255, 255, 0.08));
    }}
    .live-chat h3 {{
      margin-bottom: 0;
    }}
    .chat-thread {{
      display: grid;
      gap: 12px;
      min-height: 260px;
      max-height: 460px;
      overflow-y: auto;
      padding: 16px;
      border: 1px solid rgba(255, 255, 255, 0.24);
      border-radius: 20px;
      background:
        radial-gradient(circle at 12% 0%, rgba(116, 213, 255, 0.18), transparent 30%),
        radial-gradient(circle at 90% 100%, rgba(167, 139, 250, 0.22), transparent 32%),
        rgba(8, 19, 43, 0.72);
    }}
    .dm-row {{
      display: flex;
      align-items: flex-end;
      gap: 9px;
      animation: messageIn 160ms ease-out;
    }}
    .dm-row.user {{
      flex-direction: row-reverse;
    }}
    .dm-avatar {{
      flex: none;
      display: grid;
      place-items: center;
      width: 34px;
      height: 34px;
      border-radius: 50%;
      border: 1px solid var(--line);
      background: var(--panel2);
      color: var(--text);
      font-size: 11px;
      font-weight: 900;
    }}
    .dm-bubble {{
      max-width: min(72%, 760px);
      padding: 12px 14px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 18px 18px 18px 6px;
      background: rgba(255, 255, 255, 0.14);
      color: var(--text);
      line-height: 1.55;
      white-space: pre-wrap;
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.22);
    }}
    .dm-row.user .dm-bubble {{
      border-radius: 18px 18px 6px 18px;
      background: linear-gradient(135deg, #8ee7ff, #8b5cf6);
      color: #03101c;
      font-weight: 700;
    }}
    .dm-row.loading .dm-bubble {{
      color: var(--muted);
    }}
    .typing-dot {{
      display: inline-block;
      width: 6px;
      height: 6px;
      margin-right: 4px;
      border-radius: 50%;
      background: var(--muted);
      animation: blink 900ms infinite ease-in-out;
    }}
    .typing-dot:nth-child(2) {{
      animation-delay: 120ms;
    }}
    .typing-dot:nth-child(3) {{
      animation-delay: 240ms;
    }}
    @keyframes messageIn {{
      from {{
        opacity: 0;
        transform: translateY(6px);
      }}
      to {{
        opacity: 1;
        transform: translateY(0);
      }}
    }}
    @keyframes blink {{
      0%, 80%, 100% {{ opacity: 0.35; transform: translateY(0); }}
      40% {{ opacity: 1; transform: translateY(-2px); }}
    }}
    .chat-form {{
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
    }}
    .chat-form input {{
      min-width: 0;
      padding: 13px 14px;
      border-radius: 14px;
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.12);
      color: var(--text);
      font: inherit;
    }}
    .chat-form button {{
      padding: 13px 16px;
      border: 0;
      border-radius: 14px;
      background: linear-gradient(135deg, var(--blue), var(--purple));
      color: #03101c;
      font-weight: 900;
      cursor: pointer;
    }}
    .chat-row {{
      display: flex;
      gap: 10px;
      align-items: flex-start;
    }}
    .chat-row.user {{ flex-direction: row-reverse; }}
    .avatar {{
      flex: none;
      display: grid;
      place-items: center;
      width: 42px;
      height: 42px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: var(--panel2);
      font-size: 12px;
      font-weight: 900;
    }}
    .bubble {{
      max-width: 78%;
      padding: 12px 14px;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.12);
      line-height: 1.5;
    }}
    .user .bubble {{
      border-color: rgba(116, 213, 255, 0.55);
      background: rgba(116, 213, 255, 0.18);
    }}
    .tool .bubble, .plugin .bubble {{
      border-color: rgba(255, 84, 112, 0.45);
      background: rgba(255, 84, 112, 0.12);
    }}
    .flow-box {{
      display: grid;
      gap: 10px;
    }}
    .flow-step {{
      display: grid;
      grid-template-columns: 36px 1fr;
      gap: 12px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.1);
    }}
    .step-no {{
      display: grid;
      place-items: center;
      width: 36px;
      height: 36px;
      border-radius: 999px;
      background: var(--blue);
      color: #03101c;
      font-weight: 900;
    }}
    .metric {{
      padding: 12px 0;
      border-bottom: 1px solid var(--line);
    }}
    .metric:last-child {{ border-bottom: 0; }}
    pre, code {{
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    }}
    pre {{
      overflow: auto;
      margin: 0;
      padding: 14px;
      border-radius: 14px;
      border: 1px solid var(--line);
      background: rgba(3, 10, 18, 0.72);
      color: #d9eaff;
    }}
    code {{
      color: #bde3ff;
      background: rgba(116, 213, 255, 0.15);
      border: 1px solid rgba(116, 213, 255, 0.3);
      border-radius: 6px;
      padding: 2px 5px;
    }}
    .compare {{
      display: grid;
      grid-template-columns: 1fr 64px 1fr;
      gap: 12px;
      align-items: stretch;
    }}
    .arrow {{
      display: grid;
      place-items: center;
      color: var(--red);
      font-size: 40px;
      font-weight: 900;
    }}
    .tool-panel {{
      min-height: 160px;
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.1);
    }}
    .tool-item {{
      margin-top: 8px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.12);
    }}
    .tool-item.hot {{
      border-color: rgba(255, 84, 112, 0.65);
      background: rgba(255, 84, 112, 0.12);
    }}
    .tool-item span {{
      color: white;
      background: var(--red);
      border-radius: 999px;
      padding: 3px 8px;
      font-size: 12px;
      font-weight: 800;
    }}
    .empty {{
      display: grid;
      place-items: center;
      min-height: 100px;
      color: var(--muted);
      border: 1px dashed var(--line);
      border-radius: 12px;
    }}
    @media (max-width: 1000px) {{
      .two-col, .compare, .chat-form {{
        grid-template-columns: 1fr;
      }}
      .arrow {{
        transform: rotate(90deg);
      }}
    }}
  </style>
</head>
<body>
  <header>
    <div>
      <h1>AI AGENT Security</h1>
    </div>
  </header>
  <main>
    <section>
      <h2>시나리오 목록</h2>
      <div class="scenario-grid">
        {scenario_cards}
      </div>
    </section>
    {selected_html}
  </main>
  <script>
    const scenarioCards = Array.from(document.querySelectorAll("[data-scenario-card]"));
    const scenarioDetails = Array.from(document.querySelectorAll("[data-scenario-detail]"));
    const selectScenario = (scenarioId) => {{
      scenarioCards.forEach((card) => {{
        card.classList.toggle("active", card.dataset.scenarioCard === scenarioId);
      }});
      scenarioDetails.forEach((detail) => {{
        detail.hidden = detail.dataset.scenarioDetail !== scenarioId;
      }});
    }};

    scenarioCards.forEach((card) => {{
      card.addEventListener("click", () => selectScenario(card.dataset.scenarioCard));
    }});
    if (scenarioCards.length) {{
      selectScenario(scenarioCards[0].dataset.scenarioCard);
    }}

    document.querySelectorAll(".chat-form").forEach((form) => {{
      const detail = form.closest("[data-scenario-detail]");
      const input = form.querySelector("input");
      const thread = detail?.querySelector(".chat-thread");
      if (!input || !thread) {{
        return;
      }}
      const addMessage = (role, label, text, loading = false) => {{
        const row = document.createElement("div");
        row.className = "dm-row " + role + (loading ? " loading" : "");

        const avatar = document.createElement("div");
        avatar.className = "dm-avatar";
        avatar.textContent = label;

        const bubble = document.createElement("div");
        bubble.className = "dm-bubble";
        if (loading) {{
          bubble.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
        }} else {{
          bubble.textContent = text;
        }}

        row.appendChild(avatar);
        row.appendChild(bubble);
        thread.appendChild(row);
        thread.scrollTop = thread.scrollHeight;
        return row;
      }};

      form.addEventListener("submit", async (event) => {{
        event.preventDefault();
        const message = input.value.trim();
        if (!message) {{
          return;
        }}

        addMessage("user", "나", message);
        const loadingRow = addMessage("assistant", "OC", "", true);
        input.value = "";
        try {{
          const response = await fetch("/api/chat", {{
            method: "POST",
            headers: {{ "Content-Type": "application/json" }},
            body: JSON.stringify({{ message }}),
          }});
          const data = await response.json();
          if (!response.ok || !data.ok) {{
            loadingRow.remove();
            addMessage("assistant", "OC", "전송 실패\\n" + (data.error || JSON.stringify(data, null, 2)));
            return;
          }}
          const reply = data.response?.reply;
          const waitStatus = data.response?.wait?.status || data.response?.send?.status || "unknown";
          loadingRow.remove();
          addMessage(
            "assistant",
            "OC",
            reply || "OpenClaw 응답 대기 상태: " + waitStatus + "\\n" + JSON.stringify(data.response, null, 2),
          );
        }} catch (error) {{
          loadingRow.remove();
          addMessage("assistant", "OC", "대시보드 서버로 열어야 실제 대화가 가능합니다.\\n실행: python3 dashboard/server.py");
        }}
      }});
    }});
  </script>
</body>
</html>
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Render SG-ClawWatch dashboard.")
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(build_report(), encoding="utf-8")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
