import {
  DocBlock,
  DocDef,
  DocDefList,
  DocLede,
  DocNote,
  DocP,
  DocStep,
  DocSteps,
} from "./DocsPrimitives";

export function ChatDocs() {
  return (
    <div className="docs-article">
      <DocLede>
        Chat 탭에서는 AI 에이전트와의 <strong>대화를 실시간으로 확인</strong>하고,
        직접 메시지를 보내 테스트할 수 있습니다.
        도구 호출 내역과 보안 탐지 결과가 대화 흐름 안에 함께 표시됩니다.
      </DocLede>

      <DocNote tone="warn" title="먼저 연결하세요">
        좌측 패널에서 게이트웨이에 연결한 뒤에 대화 내역이 수신됩니다.
        연결 전에는 채팅창이 비어 있습니다.
      </DocNote>

      <DocBlock title="대화 흐름">
        <DocP>화면 중앙에서 에이전트와의 대화를 확인합니다.</DocP>
        <DocDefList>
          <DocDef term="메시지">
            사용자 메시지와 에이전트 응답이 순서대로 표시됩니다.
          </DocDef>
          <DocDef term="도구 호출">
            각 메시지 아래에 해당 턴에서 호출된 도구 목록이 나타납니다.
            도구를 클릭하면 입력 인자와 출력 결과를 펼쳐볼 수 있습니다.
          </DocDef>
        </DocDefList>
      </DocBlock>

      <DocBlock title="보안 탐지 알림">
        <DocP>
          Sentinel이 위협을 탐지하면 대화 흐름 안에 차단 알림이 표시됩니다.
          탐지 유형(악성 플러그인·악성 MD·API Abuse 등)이 함께 나타나며,
          버튼을 누르면 Monitoring 탭의 해당 내역으로 바로 이동합니다.
          차단된 경우 에이전트 응답은 자동으로 숨겨집니다.
        </DocP>
      </DocBlock>

      <DocBlock title="메시지 입력">
        <DocP>하단 입력창에서 직접 메시지를 보낼 수 있습니다.</DocP>
        <DocSteps>
          <DocStep>입력창에 메시지를 작성합니다.</DocStep>
          <DocStep>Enter로 전송, Shift+Enter로 줄바꿈합니다.</DocStep>
          <DocStep>전송 중에는 버튼이 비활성화되어 중복 전송을 방지합니다.</DocStep>
        </DocSteps>
      </DocBlock>
    </div>
  );
}
