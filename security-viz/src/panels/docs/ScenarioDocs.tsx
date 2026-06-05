import {
  DocBlock,
  DocDef,
  DocDefList,
  DocLede,
  DocNote,
  DocStep,
  DocSteps,
} from "./DocsPrimitives";

export function ScenarioDocs() {
  return (
    <div className="docs-article">
      <DocLede>
        Test Scenario 탭에서는 실제 공격 시나리오를 직접 실행하고,
        AI Agent의 <strong>탐지 및 차단 동작</strong>을 확인할 수 있습니다.
      </DocLede>

      <DocNote tone="warn" title="먼저 연결하세요">
        게이트웨이에 연결된 상태에서만 시나리오를 실행할 수 있습니다.
        연결 전에는 실행 버튼이 비활성화됩니다.
      </DocNote>

      <DocBlock title="시나리오 구성">
        <DocDefList>
          <DocDef term="S1 — 악성 플러그인 공급망 공격">
            화이트리스트에 없는 플러그인(ai_image_gen)이 사전 설치된 환경에서
            Agent가 해당 도구를 호출하려 할 때 Sentinel이 실행 전에 차단합니다.
          </DocDef>
          <DocDef term="S2 — 프롬프트 인젝션 & 데이터 유출">
            악의적인 명령이 삽입된 Markdown 파일을 Agent가 읽는 과정에서
            프롬프트 인젝션 패턴을 감지하고 후속 도구 호출을 차단합니다.
          </DocDef>
          <DocDef term="S3 — API Abuse / Denial-of-Wallet">
            반복적인 API 호출 패턴을 감지하여 설정된 호출 한도 초과 시
            세션을 자동으로 차단합니다.
          </DocDef>
        </DocDefList>
      </DocBlock>

      <DocBlock title="시나리오 실행 방법">
        <DocSteps>
          <DocStep>실행할 시나리오 카드의 <strong>시나리오 실행</strong> 버튼을 클릭합니다.</DocStep>
          <DocStep>Chat 탭에서 Agent와의 대화 흐름 및 차단 알림을 확인합니다.</DocStep>
          <DocStep>차단 알림의 버튼을 눌러 Monitoring 탭에서 탐지 상세 내역을 확인합니다.</DocStep>
          <DocStep>Policy 탭에서 악성 플러그인 삭제 등 조치를 수행합니다.</DocStep>
        </DocSteps>
      </DocBlock>

      <DocBlock title="상태 표시">
        <DocDefList>
          <DocDef term="ACTIVE">현재 실행 중인 시나리오입니다.</DocDef>
          <DocDef term="GATEWAY / MONITORING">
            우측 상단의 게이트웨이 연결 상태와 Sentinel 모니터링 활성화 여부를 나타냅니다.
          </DocDef>
        </DocDefList>
      </DocBlock>

      <DocNote tone="tip" title="탐지 결과 확인">
        시나리오 실행 후 Monitoring 탭의 History에서 탐지 유형, 심각도,
        실행 흐름을 함께 확인할 수 있습니다.
      </DocNote>
    </div>
  );
}
