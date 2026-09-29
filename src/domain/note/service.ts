import { withTransaction } from '../../config/db.js';
import type { ErrorCode } from '../../errors.js';
import { appendEvent } from '../events/append.js';
import type { DenialStage } from '../events/types.js';
import { settle, type Outcome } from '../outcome.js';
import { findAgentMembership } from '../policy/repository.js';
import { recordToolDenied } from '../policy/scope-check.js';
import { assertProjectVisibleToUser, type UserContext } from '../project/visibility.js';
import { findTaskById } from '../task/repository.js';
import type { AgentContext } from '../task/service.js';
import type { NoteKind } from './kinds.js';
import {
  findNoteById,
  findSpecFeatureKey,
  insertNote,
  listNotes,
  listOtherAgentIdentifiers,
  type Note,
} from './repository.js';
import { buildNoteTitle } from './title.js';
import { findForeignAgentMentions, validateNoteShape, type MentionTarget, type NoteViolation } from './validate.js';

// 노트 발행은 정책 게이트가 없다. 이벤트 payload의 라벨로만 쓰인다 (action_catalog의 키가 아니다).
const PUBLISH_LABEL = 'note:publish';

export const NOTES_PAGE = { default: 20, max: 50 } as const;

export type PublishNoteInput = {
  kind: NoteKind;
  headline: string;
  keyPoints: string[];
  affects: string[];
  supersedes?: string;
};

export type PublishedNote = { note: Note; title: string };

export async function publishNote(
  ctx: AgentContext,
  taskId: string,
  input: PublishNoteInput,
): Promise<PublishedNote> {
  return settle(
    await withTransaction<Outcome<PublishedNote>>(async (tx) => {
      const deny = async (
        stage: DenialStage,
        detail: string,
        code: ErrorCode,
        extra: { repoId?: string | null } = {},
      ): Promise<Outcome<PublishedNote>> => {
        await recordToolDenied(tx, {
          ...ctx,
          actionKey: PUBLISH_LABEL,
          repoId: extra.repoId ?? null,
          stage,
          detail,
        });
        return { denied: { code, message: detail } };
      };

      // claim_task와 같은 검사다. 잡지 않은 태스크에 노트를 붙이면 기록의 주인이 흐려진다.
      const membership = await findAgentMembership(tx, ctx.agentId);
      if (!membership || membership.projectId !== ctx.projectId) {
        return deny('membership', 'agent is not a member of this project', 'NOT_PROJECT_MEMBER');
      }

      const task = await findTaskById(tx, taskId);
      if (!task || task.projectId !== ctx.projectId) {
        return { denied: { code: 'TASK_NOT_FOUND', message: `task ${taskId} not found` } };
      }
      if (task.assigneeAgentId !== ctx.agentId) {
        return deny('membership', 'task is assigned to another agent', 'NOT_TASK_ASSIGNEE', {
          repoId: task.repoId,
        });
      }

      const violations: NoteViolation[] = validateNoteShape(input);

      // 과실 주장 판별. 자연어로 심사하지 않는다(P2) — 같은 프로젝트의 다른 에이전트 id·이름이
      // 문자열로 들어 있는지만 DB 조회로 확정 판정한다.
      const others = await listOtherAgentIdentifiers(tx, ctx.projectId, ctx.agentId);
      const targets: MentionTarget[] = [
        { field: 'headline', text: input.headline },
        ...input.keyPoints.map((text, index) => ({ field: 'keyPoints' as const, index, text })),
      ];
      violations.push(...findForeignAgentMentions(targets, others));

      if (input.supersedes !== undefined) {
        const previous = await findNoteById(tx, input.supersedes);
        if (!previous || previous.projectId !== ctx.projectId) {
          violations.push({ field: 'supersedes', message: '같은 프로젝트의 노트만 정정할 수 있습니다' });
        }
      }

      // 형식 위반은 권한 거부가 아니다. TOOL_DENIED를 남기지 않고 422로 되돌려준다 —
      // 섞으면 M5′(차단된 도구 호출)의 분자에 오타가 들어간다.
      if (violations.length > 0) {
        return { denied: { code: 'NOTE_INVALID', message: 'note validation failed', details: violations } };
      }

      // 연결(spec·repo)은 태스크에서 물려받는다. 클라이언트가 고르게 하면 아무 명세에나 붙일 수 있다.
      const featureKey = task.specId ? await findSpecFeatureKey(tx, task.specId) : null;
      const note = await insertNote(tx, {
        projectId: ctx.projectId,
        taskId: task.id,
        specId: task.specId,
        repoId: task.repoId,
        kind: input.kind,
        headline: input.headline,
        keyPoints: input.keyPoints,
        affects: input.affects,
        authorAgentId: ctx.agentId,
        onBehalfOf: ctx.onBehalfOf,
        supersedes: input.supersedes ?? null,
      });

      const title = buildNoteTitle({
        seq: note.seq,
        teamRole: membership.teamRole,
        featureKey,
        kind: note.kind,
        headline: note.headline,
      });

      await appendEvent(tx, {
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        type: 'NOTE_PUBLISHED',
        actorAgentId: ctx.agentId,
        onBehalfOf: ctx.onBehalfOf,
        policyHash: ctx.policyHash,
        payload: {
          noteId: note.id,
          seq: note.seq,
          kind: note.kind,
          title,
          specId: note.specId,
          affectsCount: note.affects.length,
        },
      });

      return { value: { note, title } };
    }),
  );
}

export type ReadNotesFilter = { specId?: string; sinceSeq?: number; limit?: number };

// 읽기는 이벤트를 남기지 않는다. 조회까지 기록하면 events가 열람 로그가 되고,
// 리플레이에서 "무엇이 상태를 바꿨나"를 찾기 어려워진다.
export async function readNotes(
  ctx: AgentContext,
  projectId: string,
  filter: ReadNotesFilter,
): Promise<Note[]> {
  return settle(
    await withTransaction<Outcome<Note[]>>(async (tx) => {
      const membership = await findAgentMembership(tx, ctx.agentId);
      if (!membership || membership.projectId !== ctx.projectId || projectId !== ctx.projectId) {
        return { denied: { code: 'NOT_PROJECT_MEMBER', message: 'agent is not a member of this project' } };
      }
      const limit = Math.min(filter.limit ?? NOTES_PAGE.default, NOTES_PAGE.max);
      return { value: await listNotes(tx, { projectId, ...filter, limit }) };
    }),
  );
}

// 같은 노트를 사람도 읽는다. 노트는 "무엇을 어떻게 진행했는가"의 기록이므로
// 대표·팀원이 진행 상황을 확인하는 화면의 본문이 된다.
//
// 에이전트 경로와 두 가지가 다르다. 프로젝트 판정을 토큰의 project_id가 아니라
// 멤버십에서 하고(사람 토큰에는 project_id가 없다), 거부를 TOOL_DENIED로 남기지 않는다 —
// 사람의 권한 부족은 도구 호출 차단이 아니므로 M5′ 분모에 섞으면 안 된다.
export async function listNotesForUser(
  actor: UserContext,
  projectId: string,
  filter: ReadNotesFilter,
): Promise<Note[]> {
  return withTransaction(async (tx) => {
    await assertProjectVisibleToUser(tx, actor, projectId);
    const limit = Math.min(filter.limit ?? NOTES_PAGE.default, NOTES_PAGE.max);
    return listNotes(tx, { projectId, ...filter, limit });
  });
}
