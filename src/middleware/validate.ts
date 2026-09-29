import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';
import { AppError } from '../errors.js';

type Schemas = {
  body?: ZodType;
  params?: ZodType;
  query?: ZodType;
};

// body/params/query를 주어진 zod 스키마로 검증하고, 통과한 값으로 req를 덮어쓴다.
// 이후의 라우트/서비스 코드는 입력이 이미 검증되었다고 가정할 수 있다.
export function validate(schemas: Schemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      if (schemas.body) {
        req.body = schemas.body.parse(req.body);
      }
      if (schemas.params) {
        req.params = schemas.params.parse(req.params) as Request['params'];
      }
      if (schemas.query) {
        // Express 5의 req.query는 setter가 없는 getter라 대입하면 TypeError가 난다.
        // 인스턴스에 직접 프로퍼티를 정의해 프로토타입의 getter를 가린다.
        Object.defineProperty(req, 'query', {
          value: schemas.query.parse(req.query),
          configurable: true,
          writable: true,
          enumerable: true,
        });
      }
      next();
    } catch (err) {
      next(new AppError('VALIDATION_ERROR', 'request validation failed', err));
    }
  };
}
