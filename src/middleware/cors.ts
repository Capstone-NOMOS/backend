import type { NextFunction, Request, Response } from 'express';

// 프론트(Vercel)는 API와 오리진이 다르다. 브라우저가 막지 않게 허용 오리진에만 CORS 헤더를 붙인다.
//
// CORS는 인증이 아니다. 허용되지 않은 오리진의 요청도 처리는 된다 — 브라우저가 응답을 읽지 못하게 할 뿐이고,
// 실제 권한은 Bearer 토큰이 결정한다. 쿠키를 쓰지 않으므로 Allow-Credentials는 붙이지 않는다.
//
// 허용 규칙은 두 가지뿐이다.
//   정확 일치   https://nomos.vercel.app
//   접두 와일드  https://*-myteam.vercel.app   (프리뷰 배포: <프로젝트>-<해시>-<팀>.vercel.app)
// 와일드카드는 호스트 첫 라벨의 맨 앞에만 올 수 있고, 같은 라벨 안에 고정 접미사가 있어야 한다.
// https://*.vercel.app을 허용하면 남의 Vercel 앱이 전부 우리 오리진이 된다.

export type OriginRule = { exact: string } | { pattern: RegExp; source: string };

const ORIGIN_SHAPE = /^https?:\/\/[^/?#\s]+$/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compileOriginRules(spec: string | undefined): OriginRule[] {
  if (spec === undefined || spec.trim() === '') return [];
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((entry): OriginRule => {
      const origin = entry.replace(/\/+$/, '').toLowerCase();
      if (!ORIGIN_SHAPE.test(origin)) {
        throw new Error(`CORS_ALLOWED_ORIGINS: "${entry}" is not an origin (scheme://host[:port], no path)`);
      }
      const star = origin.indexOf('*');
      if (star === -1) return { exact: origin };

      const scheme = origin.slice(0, origin.indexOf('://') + 3);
      const host = origin.slice(scheme.length);
      const firstLabel = host.split('.')[0] ?? '';
      // '*'는 한 번, 첫 라벨의 맨 앞에만. 그 뒤로 같은 라벨 안에 고정 문자가 있어야 한다.
      if (star !== scheme.length || origin.indexOf('*', star + 1) !== -1 || firstLabel.length < 2) {
        throw new Error(
          `CORS_ALLOWED_ORIGINS: "${entry}" — wildcard is only allowed as a prefix of the first label with a fixed suffix (e.g. https://*-myteam.vercel.app)`,
        );
      }
      const rest = host.slice(1); // '*' 다음부터
      // '*'는 점을 넘지 않는다 — 한 라벨 안에서만 매칭된다.
      return { pattern: new RegExp(`^${escapeRegExp(scheme)}[a-z0-9-]+${escapeRegExp(rest)}$`), source: origin };
    });
}

export function isAllowedOrigin(rules: readonly OriginRule[], origin: string): boolean {
  const o = origin.toLowerCase();
  return rules.some((r) => ('exact' in r ? r.exact === o : r.pattern.test(o)));
}

const ALLOW_METHODS = 'GET, POST, PATCH, DELETE';
const ALLOW_HEADERS = 'Authorization, Content-Type';

export function cors(rules: readonly OriginRule[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.header('Origin');
    // 오리진마다 응답이 달라지므로 캐시가 섞이지 않게 한다.
    res.vary('Origin');
    const allowed = origin !== undefined && isAllowedOrigin(rules, origin);
    if (allowed) res.set('Access-Control-Allow-Origin', origin);

    // 사전 요청은 라우트까지 내려보내지 않는다. 허용되지 않은 오리진에도 204를 주되 헤더를 빼서
    // 브라우저가 막게 한다 — 라우트로 흘리면 404 JSON이 나가 원인이 흐려진다.
    if (req.method === 'OPTIONS' && req.header('Access-Control-Request-Method') !== undefined) {
      if (allowed) {
        res.set('Access-Control-Allow-Methods', ALLOW_METHODS);
        res.set('Access-Control-Allow-Headers', ALLOW_HEADERS);
        res.set('Access-Control-Max-Age', '600');
      }
      res.status(204).end();
      return;
    }
    next();
  };
}
