import { parseRoutingResponse, type QuestionRouter, type RoutingInput } from './router.js';

// Decision AI(Jev 등) 라우터 — 외부 결정 모델에 RoutingInput을 POST하고 { target, confidence?, reason?, costUsd? }를 받는다.
// 그쪽 API 형식이 다르면 이 파일만 바꾼다 — 서버·평가 장치는 QuestionRouter만 본다.
// 조직 id(context)는 보내지 않는다. 질문·명세 본문이 외부로 나가므로 운영에 켜기 전에 팀이 동의해야 한다.

export function httpQuestionRouter(url: string, fetchImpl: typeof fetch = fetch): QuestionRouter {
  const routedBy = `decision:${new URL(url).host}`;
  return {
    name: routedBy,
    async route(input: RoutingInput) {
      const { context: _context, ...body } = input;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`${routedBy} returned ${res.status}`);
      const text = await res.text();
      const decision = parseRoutingResponse(text, input, routedBy);
      const cost = (JSON.parse(text) as { costUsd?: unknown }).costUsd;
      return { ...decision, costUsd: typeof cost === 'number' ? cost : null };
    },
  };
}
