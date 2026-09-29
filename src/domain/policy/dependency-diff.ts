// dep:add 판정. package.json이 바뀌었다고 무조건 dep:add가 아니라,
// dependencies/devDependencies에 새 패키지가 들어오거나 버전이 바뀐 경우만 걸린다.
// (scripts만 고친 변경, lock 파일 갱신은 dep:add가 아니다.)

const SECTIONS = ['dependencies', 'devDependencies'] as const;

export type DependencySection = (typeof SECTIONS)[number];

export type DependencyChange = {
  section: DependencySection;
  name: string;
  from: string | null; // 이 섹션에 없던 패키지면 null
  to: string;
};

export type DependencyDiff = {
  changes: DependencyChange[];
  // 바뀐 뒤의 package.json을 읽을 수 없으면 판정할 수 없다 — 호출부는 dep:add로 취급해야 한다(fail closed).
  unparseable: boolean;
};

type Sections = Record<DependencySection, Record<string, string>>;

function readSections(text: string | null): Sections | null {
  const empty: Sections = { dependencies: {}, devDependencies: {} };
  if (text === null) return empty;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const result = empty;
  for (const section of SECTIONS) {
    const value = (parsed as Record<string, unknown>)[section];
    if (value === undefined) continue;
    if (typeof value !== 'object' || value === null) return null;
    for (const [name, version] of Object.entries(value)) {
      if (typeof version !== 'string') return null;
      result[section][name] = version;
    }
  }
  return result;
}

// before: 변경 전 package.json 내용 (새 파일이면 null), after: 변경 후 내용 (삭제면 null).
// 제거는 추가가 아니므로 changes에 넣지 않는다.
export function diffDependencies(before: string | null, after: string | null): DependencyDiff {
  if (after === null) return { changes: [], unparseable: false };

  const next = readSections(after);
  if (next === null) return { changes: [], unparseable: true };
  // 변경 전을 못 읽으면 변경 후의 의존성 전부를 새로 들어온 것으로 본다 — 더 엄격한 쪽.
  const prev = readSections(before) ?? { dependencies: {}, devDependencies: {} };

  const changes: DependencyChange[] = [];
  for (const section of SECTIONS) {
    for (const [name, to] of Object.entries(next[section])) {
      const from = prev[section][name] ?? null;
      if (from !== to) changes.push({ section, name, from, to });
    }
  }
  return { changes, unparseable: false };
}

export function isDependencyAddition(before: string | null, after: string | null): boolean {
  const diff = diffDependencies(before, after);
  return diff.unparseable || diff.changes.length > 0;
}
