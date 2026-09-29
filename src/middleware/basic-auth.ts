import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

// 원격 서버의 Swagger UI를 팀원만 보게 하는 문지기. 우리 JWT로 막지 못하는 이유는
// 브라우저가 페이지를 열 때 Authorization: Bearer를 붙일 수 없기 때문이다.
//
// 비교는 양쪽을 sha256으로 같은 길이로 만든 뒤 상수 시간으로 한다. 문자열을 그대로 비교하면
// 앞에서부터 몇 글자가 맞았는지가 응답 시간으로 샌다.
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function basicAuth(credentials: string, realm = 'nomos-docs') {
  const expected = digest(credentials);
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('Authorization') ?? '';
    const match = /^Basic ([A-Za-z0-9+/=]+)$/.exec(header);
    const provided = match?.[1] ? Buffer.from(match[1], 'base64').toString('utf8') : '';
    if (provided !== '' && timingSafeEqual(digest(provided), expected)) {
      next();
      return;
    }
    res.set('WWW-Authenticate', `Basic realm="${realm}", charset="UTF-8"`);
    res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'docs require basic authentication' } });
  };
}
