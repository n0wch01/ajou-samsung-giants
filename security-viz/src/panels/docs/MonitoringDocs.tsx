import {
  DocBlock,
  DocCode,
  DocDef,
  DocDefList,
  DocLede,
  DocNote,
  DocP,
  DocStep,
  DocSteps,
} from "./DocsPrimitives";

/**
 * Monitoring 탭 사용 설명서.
 * 구조는 실제 Monitoring 탭(StageMonitoring.tsx)의 구성과 1:1로 맞춰져 있다.
 */
export function MonitoringDocs() {
  return (
    <div className="docs-article">
      <DocLede>
        Monitoring 탭에서는 AI 에이전트가 실행되는 동안 탐지된{" "}
        <strong>보안 위협을 실시간으로 확인</strong>할 수 있습니다.
        탐지 건수 요약, 유형별 비율 차트, 그리고 각 탐지의 상세 내역과 대응 방법을 제공합니다.
      </DocLede>

      <DocNote tone="warn" title="먼저 연결하고 시나리오를 실행하세요">
        좌측 패널에서 게이트웨이에 연결한 뒤 Test Scenario 탭에서 시나리오를 실행해야
        탐지 내역이 나타납니다. 연결 전에는 이전 세션 데이터가 보이지 않습니다.
      </DocNote>

      <DocBlock title="요약 카드">
        <DocP>
          화면 상단에 세 가지 탐지 유형의 건수가 카드 형태로 표시됩니다.
          숫자가 0보다 크면 해당 유형의 위협이 탐지된 것입니다.
        </DocP>
      </DocBlock>

      <DocBlock title="도넛 차트">
        <DocP>
          카드 오른쪽의 원형 차트는 전체 탐지 건수 중 각 유형이 차지하는 비율을 색으로 보여줍니다.
          가운데 숫자가 총 탐지 건수입니다.
        </DocP>
        <DocDefList>
          <DocDef term="빨간색">악성 플러그인 탐지</DocDef>
          <DocDef term="노란색">악성 MD 탐지</DocDef>
          <DocDef term="파란색">API Abuse 탐지</DocDef>
          <DocDef term="회색">기타 탐지</DocDef>
        </DocDefList>
        <DocP>탐지 건수가 없으면 차트 대신 "탐지 없음"이 표시됩니다.</DocP>
      </DocBlock>

      <DocBlock title="탐지 내역 목록">
        <DocP>
          아래 "탐지 내역" 섹션에 탐지된 항목이 최신순으로 나열됩니다.
          각 항목에는 다음 정보가 표시됩니다.
        </DocP>
        <DocDefList>
          <DocDef term="심각도 배지">
            위협의 심각한 정도를 나타냅니다.{" "}
            <DocCode>CRITICAL</DocCode> · <DocCode>HIGH</DocCode>는 즉시 대응이 필요하고,{" "}
            <DocCode>MEDIUM</DocCode> · <DocCode>LOW</DocCode>는 모니터링 수준입니다.
          </DocDef>
          <DocDef term="탐지 유형">악성 플러그인 / 악성 MD / API Abuse / 기타 중 하나로 분류됩니다.</DocDef>
          <DocDef term="탐지 제목">어떤 규칙에 의해 탐지됐는지 한 줄로 설명합니다.</DocDef>
          <DocDef term="Rule ID">탐지에 사용된 내부 규칙 이름입니다. 상세 규칙은 Sentinel 설정에서 확인할 수 있습니다.</DocDef>
          <DocDef term="탐지 시각">탐지가 발생한 날짜와 시간입니다.</DocDef>
        </DocDefList>
        <DocNote tone="tip" title="항목 클릭으로 상세 보기">
          각 항목을 클릭하면 펼쳐져 상세 내용과 대응 방법을 확인할 수 있습니다.
          다시 클릭하면 접힙니다.
        </DocNote>
      </DocBlock>

      <DocBlock title="탐지 항목 상세 보기">
        <DocP>항목을 펼치면 다음 네 가지 섹션이 나타납니다.</DocP>
        <DocSteps>
          <DocStep>
            <strong>탐지 메시지</strong> — 어떤 행동이 감지됐는지 구체적인 내용을 보여줍니다.
            예를 들어 어떤 도구가 몇 번 호출됐는지, 어떤 파일에서 패턴이 발견됐는지 알 수 있습니다.
          </DocStep>
          <DocStep>
            <strong>권고 조치</strong> — Sentinel이 자동으로 제안하는 대응 방법입니다.
            이 내용을 먼저 확인하고, 아래 "조치" 버튼으로 실제 대응을 진행하세요.
          </DocStep>
          <DocStep>
            <strong>실행 흐름</strong> — 탐지가 발생하기 직전까지 AI 에이전트가 어떤 순서로
            도구를 호출했는지 타임라인으로 보여줍니다. 공격 경로를 추적하는 데 활용할 수 있습니다.
          </DocStep>
          <DocStep>
            <strong>조치</strong> — 탐지 유형에 따라 구체적인 해결 버튼이 나타납니다.
            아래 "조치 방법" 섹션에서 유형별 대응을 자세히 설명합니다.
          </DocStep>
        </DocSteps>
      </DocBlock>

      <DocBlock title="조치 방법">
        <DocP>탐지 유형마다 다른 대응 방법이 제공됩니다.</DocP>
        <DocDefList>
          <DocDef term="악성 플러그인 탐지 시">
            "Policy 탭에서 플러그인 삭제 →" 버튼을 클릭하면 Policy 탭으로 이동하고,
            해당 도구가 강조 표시됩니다. 도구 옆 "삭제" 버튼을 눌러 제거하세요.
          </DocDef>
          <DocDef term="악성 MD 탐지 시">
            탐지 메시지에 표시된 마크다운 파일을 직접 열어 악성 지시문을 확인하고 삭제하세요.
            파일을 수정하지 않으면 동일한 탐지가 반복될 수 있습니다.
          </DocDef>
          <DocDef term="API Abuse 탐지 시">
            "Policy 탭에서 허용 범위 수정 →" 버튼을 클릭하면 Policy 탭의 Rate Limit 설정으로
            이동합니다. 최대 호출 횟수나 시간 범위를 조정해 허용 한도를 변경할 수 있습니다.
          </DocDef>
        </DocDefList>
        <DocNote tone="info" title="조치 후 재테스트">
          조치를 완료했다면 Test Scenario 탭에서 동일한 시나리오를 다시 실행해
          탐지가 사라지거나 차단이 정상 동작하는지 확인해보세요.
        </DocNote>
      </DocBlock>
    </div>
  );
}
