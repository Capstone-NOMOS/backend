import type { TeamRole } from '../roles.js';
import type { ProjectSnapshot } from './repository.js';
import type { SpecInput, TaskKind } from './schema.js';

// 명세·태스크 작성 검증 — API·파일 들여오기·(나중에) PM이 모두 이 한 벌을 거친다.
// SQL을 모른다. repository가 읽어 온 프로젝트 상태(ProjectSnapshot)만 보고 판정한다.
// 틀린 곳은 하나에서 멈추지 않고 **전부** 모은다 — 하나 고치고 다시 보내게 하지 않는다.

// 가리키는 방식은 경로마다 다르다. API는 id로, 파일은 이름·묶음 안 임시 키(ref)로 가리킨다.
export type RepoRef = { id: string } | { fullName: string };
export type SpecRef = { id: string } | { featureKey: string };
export type TaskRef = { id: string } | { ref: string };

export type TaskDraft = {
  // 묶음 안에서 이 태스크를 가리키는 이름(선행 관계용). DB에는 저장하지 않는다.
  ref: string;
  title: string;
  teamRole: TeamRole | null;
  kind: TaskKind;
  repo: RepoRef;
  spec: SpecRef | null;
  dependsOn: TaskRef[];
};

export type Problem = { where: string; message: string };

// 검증을 통과한 뒤의 모양. 가리키는 대상이 전부 풀려 있다.
export type ResolvedTask = {
  ref: string;
  title: string;
  teamRole: TeamRole | null;
  kind: TaskKind;
  repoId: string;
  spec: { newKey: string } | { existingId: string } | null;
  dependsOn: ({ ref: string } | { existingId: string })[];
};

export function validateAuthoring(
  snapshot: ProjectSnapshot,
  input: { specs: SpecInput[]; tasks: TaskDraft[] },
): { problems: Problem[]; tasks: ResolvedTask[] } {
  const problems: Problem[] = [];
  const existingSpecByKey = new Map(snapshot.specs.map((s) => [s.featureKey, s.id]));
  const existingSpecIds = new Set(snapshot.specs.map((s) => s.id));

  // ── 명세
  const newSpecKeys = new Set<string>();
  for (const spec of input.specs) {
    const where = `specs[${spec.featureKey}]`;
    if (newSpecKeys.has(spec.featureKey)) problems.push({ where, message: `명세 ${spec.featureKey}가 두 번 있다` });
    // 조용히 버전을 올리지 않는다. 명세 변경은 기록이 남아야 하는 결정이다(개정은 G1과 함께).
    if (existingSpecByKey.has(spec.featureKey)) {
      problems.push({ where, message: `명세 ${spec.featureKey}가 프로젝트에 이미 있다 (다시 보낸 건 아닌가?)` });
    }
    newSpecKeys.add(spec.featureKey);
  }

  // ── 태스크: 묶음 안 중복
  const refs = new Set<string>();
  const titles = new Set<string>();
  for (const task of input.tasks) {
    const where = `tasks[${task.ref}]`;
    if (refs.has(task.ref)) problems.push({ where, message: `태스크 ref ${task.ref}가 두 번 있다` });
    refs.add(task.ref);
    if (titles.has(task.title)) problems.push({ where, message: `태스크 제목 "${task.title}"이 두 번 있다` });
    titles.add(task.title);
    // 같은 제목 거부 — 버튼 두 번 누르기와 파일 재실행이 태스크를 불리지 않게. REWORK가 같은 제목을 쓰게 되면 이 규칙을 다시 본다.
    if (snapshot.taskTitles.has(task.title)) {
      problems.push({ where, message: `태스크 "${task.title}"이 프로젝트에 이미 있다 (다시 보낸 건 아닌가?)` });
    }
  }

  // ── 태스크: 가리키는 대상 풀기
  const tasks: ResolvedTask[] = input.tasks.map((task) => {
    const where = `tasks[${task.ref}]`;

    const repo =
      'id' in task.repo
        ? snapshot.repos.find((r) => r.id === (task.repo as { id: string }).id)
        : snapshot.repos.find((r) => r.fullName === (task.repo as { fullName: string }).fullName);
    if (!repo) {
      const label = 'id' in task.repo ? task.repo.id : task.repo.fullName;
      const linked = snapshot.repos.map((r) => r.fullName).join(', ') || '없음';
      problems.push({ where, message: `레포 ${label}는 이 프로젝트에 연결돼 있지 않다 (연결된 레포: ${linked})` });
    }

    let spec: ResolvedTask['spec'] = null;
    if (task.spec !== null) {
      if ('featureKey' in task.spec) {
        if (newSpecKeys.has(task.spec.featureKey)) spec = { newKey: task.spec.featureKey };
        else if (existingSpecByKey.has(task.spec.featureKey)) spec = { existingId: existingSpecByKey.get(task.spec.featureKey)! };
        else problems.push({ where, message: `명세 ${task.spec.featureKey}가 이 묶음에도 프로젝트에도 없다` });
      } else if (existingSpecIds.has(task.spec.id)) {
        spec = { existingId: task.spec.id };
      } else {
        problems.push({ where, message: `명세 ${task.spec.id}는 이 프로젝트의 명세가 아니다` });
      }
    } else if (task.kind === 'IMPLEMENT') {
      // 구현 태스크에 명세가 없으면 브리핑에 무엇을 만들지가 비고, V2 시험지도 없다. 통합·재작업만 명세 없이 둔다.
      problems.push({ where, message: '구현(IMPLEMENT) 태스크에는 명세가 필요하다 (명세 없이 만들 수 있는 건 INTEGRATION·REWORK)' });
    }

    const dependsOn: ResolvedTask['dependsOn'] = [];
    for (const dep of task.dependsOn) {
      if ('ref' in dep) {
        if (dep.ref === task.ref) problems.push({ where, message: '자기 자신에 의존한다' });
        else if (refs.has(dep.ref)) dependsOn.push({ ref: dep.ref });
        else problems.push({ where, message: `선행 태스크 ${dep.ref}가 이 묶음에 없다` });
      } else if (snapshot.taskIds.has(dep.id)) {
        dependsOn.push({ existingId: dep.id });
      } else {
        problems.push({ where, message: `선행 태스크 ${dep.id}는 이 프로젝트의 태스크가 아니다` });
      }
    }

    return {
      ref: task.ref,
      title: task.title,
      teamRole: task.teamRole,
      kind: task.kind,
      repoId: repo?.id ?? '',
      spec,
      dependsOn,
    };
  });

  // 묶음 안 의존 순환. 순환이 있으면 그 태스크들은 영원히 수령할 수 없다(선행이 DONE이 되지 않으므로).
  // 기존 태스크만 가리키는 단건 생성에서는 생길 수 없다 — 새 태스크를 가리키는 기존 태스크가 없으므로.
  const graph = new Map(tasks.map((t) => [t.ref, t.dependsOn.flatMap((d) => ('ref' in d ? [d.ref] : []))]));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (ref: string, trail: string[]): void => {
    if (state.get(ref) === 'done') return;
    if (state.get(ref) === 'visiting') {
      problems.push({ where: `tasks[${ref}]`, message: `의존 순환: ${[...trail.slice(trail.indexOf(ref)), ref].join(' → ')}` });
      return;
    }
    state.set(ref, 'visiting');
    for (const next of graph.get(ref) ?? []) visit(next, [...trail, ref]);
    state.set(ref, 'done');
  };
  for (const ref of graph.keys()) visit(ref, []);

  return { problems, tasks };
}
