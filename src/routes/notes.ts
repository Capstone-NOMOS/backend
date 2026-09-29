import { Router } from 'express';
import { z } from 'zod';
import { NOTE_KINDS } from '../domain/note/kinds.js';
import { NOTES_PAGE, listNotesForUser, publishNote, readNotes } from '../domain/note/service.js';
import { agentContextOf, authenticateAgent, authenticateAny } from '../middleware/agent-auth.js';
import { orgIdOf } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

export const notesRouter = Router();

const taskIdParamsSchema = z.object({ taskId: z.string().uuid() });

// 길이·개수 상한은 서비스와 DB가 판정한다. 여기서 zod로 한 번 더 자르면
// "몇 번째 항목이 몇 자인지" 대신 zod 메시지가 나가 에이전트가 고칠 수 없다.
const publishBodySchema = z.object({
  kind: z.enum(NOTE_KINDS),
  headline: z.string(),
  keyPoints: z.array(z.string()),
  affects: z.array(z.string()).default([]),
  supersedes: z.string().uuid().optional(),
});

// POST /api/tasks/:taskId/notes — MCP 도구 publish_note의 서버 쪽.
notesRouter.post(
  '/tasks/:taskId/notes',
  authenticateAgent,
  validate({ params: taskIdParamsSchema, body: publishBodySchema }),
  async (req, res) => {
    const { taskId } = req.params as z.infer<typeof taskIdParamsSchema>;
    const body = req.body as z.infer<typeof publishBodySchema>;
    const published = await publishNote(agentContextOf(req), taskId, body);
    res.status(201).json({ data: { ...published.note, title: published.title } });
  },
);

const projectIdParamsSchema = z.object({ projectId: z.string().uuid() });

const readQuerySchema = z.object({
  spec_id: z.string().uuid().optional(),
  since_seq: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(NOTES_PAGE.max).default(NOTES_PAGE.default),
});

// GET /api/projects/:projectId/notes — MCP 도구 read_notes의 서버 쪽이면서, 웹 UI가
// "무엇을 어떻게 진행했는가"를 보는 화면의 본문이다. 어느 쪽이든 이벤트를 남기지 않는다.
notesRouter.get(
  '/projects/:projectId/notes',
  authenticateAny,
  validate({ params: projectIdParamsSchema, query: readQuerySchema }),
  async (req, res) => {
    const { projectId } = req.params as z.infer<typeof projectIdParamsSchema>;
    // validate가 이미 파싱해 넣었지만 Express의 ParsedQs 타입과 겹치지 않아 unknown을 거친다.
    const query = req.query as unknown as z.infer<typeof readQuerySchema>;
    const filter = {
      ...(query.spec_id === undefined ? {} : { specId: query.spec_id }),
      ...(query.since_seq === undefined ? {} : { sinceSeq: query.since_seq }),
      limit: query.limit,
    };
    const notes = req.agent
      ? await readNotes(agentContextOf(req), projectId, filter)
      : await listNotesForUser(
          { userId: req.user!.id, orgId: orgIdOf(req), orgRole: req.user!.orgRole },
          projectId,
          filter,
        );
    // 다른 목록 API와 같은 모양으로 감싼다({ data: { notes } }). 여기만 배열을 그대로 내면
    // 클라이언트가 엔드포인트별로 다르게 풀어야 한다.
    res.json({ data: { notes } });
  },
);
