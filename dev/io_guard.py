import functools
import re
import logging

logging.basicConfig(level=logging.INFO, format='%(message)s')
logger = logging.getLogger("S.G.SDK.IO")

class SecurityViolationError(Exception):
    """보안 위반 시 발생시킬 커스텀 에러"""
    pass

def input_guardrail(func):
    """사용자의 입력을 에이전트에게 전달하기 전에 악성 패턴을 검사합니다."""
    @functools.wraps(func)
    async def wrapper(user_input: str, *args, **kwargs):
        logger.info(f"[Input Guard] '{user_input}'")

        # 악성 패턴
        injection_patterns = [
            r"ignore previous",      # 이전 지시 무시 시도
            r"system prompt",        # 시스템 프롬프트 탈취 시도
            r"you are now",          # 역할 강제 부여 시도
            r"bypassing",            # 우회 시도
            r"drop table"            # SQL 인젝션 시도
        ]

        lower_input = user_input.lower()
        for pattern in injection_patterns:
            if re.search(pattern, lower_input):
                logger.error(f"[Input Guard] Blocked! '{pattern}'")

                return "io_guard: input blocked by security guardrail due to detected malicious pattern."

        logger.info("[Input Guard] SAFE.")

        return await func(user_input, *args, **kwargs)
    
    return wrapper

def output_guardrail(func):
    """에이전트의 응답이 사용자에게 나가기 전에 민감 정보(PII)를 검사하고 마스킹합니다."""
    @functools.wraps(func)
    async def wrapper(*args, **kwargs):

        agent_response = await func(*args, **kwargs)
        
        logger.info(f"[Output Guard]")

        credit_card_pattern = r"\b(?:\d{4}[-\s]?){3}\d{4}\b"
        
        # 신용카드 번호가 발견되면 [REDACTED]로 마스킹 처리
        if re.search(credit_card_pattern, agent_response):
            logger.warning("⚠️ [Output Guard] 응답에서 신용카드 번호가 감지되었습니다. 마스킹 처리합니다.")
            agent_response = re.sub(credit_card_pattern, "[마스킹된 카드번호]", agent_response)

        # 시스템 에러 코드나 내부 API 키 유출 방지 (예: sk- 로 시작하는 OpenAI 키)
        api_key_pattern = r"sk-[a-zA-Z0-9]{32,}"
        if re.search(api_key_pattern, agent_response):
            logger.error("❌ [Output Guard] API 키 유출 시도 감지! 응답을 원천 차단합니다.")
            return "보안 시스템: 내부 보안 정책에 의해 응답이 차단되었습니다."

        logger.info("✅ [Output Guard] 출력 안전함. 사용자에게 전달합니다.")
        return agent_response
    
    return wrapper