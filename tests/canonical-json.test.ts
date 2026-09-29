import { describe, expect, it } from 'vitest';
import { hashObject, canonicalJson, sha256 } from '../src/utils/canonical-json.js';

describe('canonicalJson', () => {
  it('키 순서가 다른 두 객체가 같은 해시를 낸다', () => {
    const a = { name: 'nomos', version: 2, owner: { role: 'BACKEND', id: 7 } };
    const b = { owner: { id: 7, role: 'BACKEND' }, version: 2, name: 'nomos' };

    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(hashObject(a)).toBe(hashObject(b));
  });

  it('중첩된 객체의 키도 재귀적으로 정렬한다', () => {
    expect(canonicalJson({ b: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"b":{"c":2,"d":1}}');
  });

  it('공백 없이 직렬화한다', () => {
    expect(canonicalJson({ a: 1, b: [1, 2] })).toBe('{"a":1,"b":[1,2]}');
  });

  it('정수처럼 생긴 키도 사전순으로 정렬한다', () => {
    // 객체를 재조립해 JSON.stringify에 넘기면 JS가 '9'를 '10'보다 먼저 내보낸다.
    expect(canonicalJson({ '10': 'a', '9': 'b' })).toBe('{"10":"a","9":"b"}');
  });

  it('배열 순서는 의미가 있으므로 정렬하지 않는다', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(hashObject([1, 2])).not.toBe(hashObject([2, 1]));
  });

  it('내용이 다르면 해시가 다르다', () => {
    expect(hashObject({ a: 1 })).not.toBe(hashObject({ a: 2 }));
  });

  it('값이 undefined인 키는 JSON과 마찬가지로 빠진다', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('해시로 뭉개지면 안 되는 값은 던진다', () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
    expect(() => canonicalJson({ a: NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(TypeError);
  });

  it('sha256이 알려진 값을 낸다', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
