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
 * Policy 탭 사용 설명서.
 * 구조는 실제 Policy 탭(StagePolicy.tsx)의 구성과 1:1로 맞춰져 있다.
 * 문장은 자유롭게 다듬어 쓰면 된다.
 */
export function PolicyDocs() {
  return (
    <div className="docs-article">
      <DocLede>
        Policy 탭에서는 OpenClaw 게이트웨이의 <strong>보안 정책을 확인하고 설정</strong>합니다.
        도구 호출 한도를 지정하고, 현재 설정과 등록된 도구를 점검하며, 기준 상태와 비교해
        악성 플러그인 같은 위험 변경을 탐지할 수 있습니다.
      </DocLede>

      <DocNote tone="warn" title="먼저 연결하세요">
        좌측 패널에서 게이트웨이에 연결한 뒤에 각 검사 버튼이 동작합니다. 연결하지 않으면
        설정과 도구 목록을 불러올 수 없습니다.
      </DocNote>

      <DocBlock title="상단 상태바">
        <DocP>페이지 상단에서 현재 정책 상태를 한눈에 확인합니다.</DocP>
        <DocDefList>
          <DocDef term="정책 상태">
            정책 설정(<DocCode>config.get</DocCode>)을 한 번이라도 불러왔으면 “정상”, 그렇지 않으면 “미확인”으로 표시됩니다.
          </DocDef>
          <DocDef term="등록 도구">게이트웨이에 현재 등록된 전체 도구 개수입니다.</DocDef>
          <DocDef term="위험 변경">
            기준(baseline) 대비 추가·제거된 도구 수입니다. <strong>0이면 안전</strong>, 1 이상이면 점검이 필요합니다.
          </DocDef>
        </DocDefList>
      </DocBlock>

      <DocBlock title="API Abuse 탐지 정책 (Rate Limit)">
        <DocP>
          종료 조건 없이 도구를 반복 호출해 과금이 폭증하는 상황을 막기 위한 한도입니다.
          지정한 시간 안에 같은 도구를 정해진 횟수보다 많이 호출하면 탐지합니다.
        </DocP>
        <DocSteps>
          <DocStep>최대 호출 횟수와 시간 범위(초)를 입력합니다.</DocStep>
          <DocStep>저장하면 Sentinel 탐지 규칙에 즉시 반영됩니다.</DocStep>
        </DocSteps>
        <DocP>
          최대 호출 횟수를 <DocCode>0</DocCode>으로 두면 Rate Limit 탐지가 꺼집니다.
        </DocP>
      </DocBlock>

      <DocBlock title="검사 항목">
        <DocP>아래 세 가지 검사를 각 버튼으로 실행하고, “상세 보기”로 결과를 펼쳐 확인합니다.</DocP>
        <DocSteps>
          <DocStep>
            <strong>정책 설정 검사</strong> (<DocCode>config.get</DocCode>) — 현재 OpenClaw 보안 설정을
            불러와 키-값으로 보여줍니다. 검색창으로 특정 키를 찾을 수 있습니다.
          </DocStep>
          <DocStep>
            <strong>도구 목록 검사</strong> (<DocCode>tools.catalog</DocCode>) — 등록된 도구를 그룹별로
            보여줍니다. <em>플러그인</em>에서 추가된 도구는 “삭제” 버튼으로 제거할 수 있습니다.
          </DocStep>
          <DocStep>
            <strong>기준 도구 목록 비교</strong> (baseline diff) — 현재 도구 목록을 화이트리스트와
            비교해 <strong>추가·제거된 도구</strong>를 표시합니다. 기준에 없는 도구가 나타나면
            악성 플러그인(S1)으로 탐지됩니다.
          </DocStep>
        </DocSteps>
      </DocBlock>

      <DocBlock title="검사 결과 읽기">
        <DocP>
          맨 아래 “검사 결과”에 실행한 검사들이 요약됩니다. 정상은 ✓(초록), 위험·오류는
          ✗·!(빨강·주황)으로 표시되어 위험 변경 여부를 빠르게 확인할 수 있습니다.
        </DocP>
      </DocBlock>
    </div>
  );
}
