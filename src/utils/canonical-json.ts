import { createHash } from 'node:crypto';

// 객체 키를 code unit 순으로 비교한다. localeCompare는 로케일에 따라 결과가 달라져
// 같은 입력이 환경마다 다른 해시를 내므로 쓰지 않는다.
function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function serialize(value: unknown): string {
  if (value === null) return 'null';

  if (typeof value === 'boolean') return value ? 'true' : 'false';

  if (typeof value === 'number') {
    // NaN·Infinity는 JSON에서 null이 되어 서로 다른 값이 같은 해시를 내게 된다.
    if (!Number.isFinite(value)) {
      throw new TypeError(`canonicalJson: non-finite number (${value}) cannot be serialized`);
    }
    return JSON.stringify(value);
  }

  if (typeof value === 'string') return JSON.stringify(value);

  if (typeof value === 'object') {
    const withToJson = value as { toJSON?: () => unknown };
    if (typeof withToJson.toJSON === 'function') {
      return serialize(withToJson.toJSON());
    }

    // 배열의 순서는 의미가 있으므로 정렬하지 않는다. 구멍과 undefined는 JSON과 같이 null로.
    if (Array.isArray(value)) {
      return `[${value.map((v) => (v === undefined ? 'null' : serialize(v))).join(',')}]`;
    }

    // 객체를 다시 만들어 JSON.stringify에 넘기지 않고 문자열을 직접 조립하는 이유:
    // JS는 정수처럼 생긴 키('2', '10')를 삽입 순서와 무관하게 숫자 순으로 먼저 내보내므로
    // 재조립 방식으로는 정렬 순서를 보장할 수 없다.
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => compareKeys(a, b));

    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${serialize(v)}`).join(',')}}`;
  }

  // undefined, function, symbol, bigint. JSON.stringify처럼 조용히 버리면 서로 다른 입력이
  // 같은 해시를 내므로 차라리 던진다.
  throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`);
}

// 키를 재귀적으로 정렬하고 공백 없이 직렬화한다. 같은 내용이면 키 순서가 달라도 항상 같은 문자열.
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// 해시 비교용 단축 헬퍼. DAG 스냅샷·헌법 스냅샷이 실질적으로 같은지 판정할 때 쓴다.
export function hashObject(value: unknown): string {
  return sha256(canonicalJson(value));
}
