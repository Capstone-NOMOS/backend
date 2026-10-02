// NOMOS MCP 서버. 헤드리스 Claude Code가 이 서버의 도구로만 태스크를 잡고 산출물을 낸다.
//
// stdout은 MCP 프로토콜(JSON-RPC) 전용이다. 로그는 반드시 stderr로만 쓴다 —
// stdout에 한 줄이라도 섞이면 클라이언트가 프로토콜 파싱에 실패한다.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readCredentials, updateAccessToken } from './credentials.js';
import { NomosClient, PolicyStaleLoopError } from './nomos-client.js';
import { mergeAcknowledged, readBriefingNoteIds } from './briefing-notes.js';
import { pushTaskBranch } from './push.js';

// 자격 증명은 ~/.nomos/credentials가 정본이다(0600). 환경변수는 파일이 없을 때만 쓴다
// (테스트·일회성 실행용). 둘을 섞으면 재발급 결과가 어디에 저장되는지 흐려진다.
function resolveCredentials(): { baseUrl: string; accessToken: string; refreshToken: string } {
  const stored = readCredentials();
  if (stored) return stored;

  const { NOMOS_BASE_URL, NOMOS_ACCESS_TOKEN, NOMOS_REFRESH_TOKEN } = process.env;
  if (!NOMOS_BASE_URL || !NOMOS_ACCESS_TOKEN || !NOMOS_REFRESH_TOKEN) {
    process.stderr.write('[nomos-mcp] ~/.nomos/credentials가 없고 NOMOS_* 환경변수도 없습니다\n');
    process.exit(1);
  }
  return { baseUrl: NOMOS_BASE_URL, accessToken: NOMOS_ACCESS_TOKEN, refreshToken: NOMOS_REFRESH_TOKEN };
}

const credentials = resolveCredentials();

const client = new NomosClient({
  baseUrl: credentials.baseUrl,
  tokens: { accessToken: credentials.accessToken, refreshToken: credentials.refreshToken },
  // 재발급은 조용히 일어난다 — 모델은 401을 보지 못하고 도구가 그냥 성공한 것으로 본다.
  // 파일에 되돌려 써야 다음 실행이 401 없이 시작한다.
  onTokensChanged: (tokens) => {
    updateAccessToken(tokens.accessToken);
    process.stderr.write('[nomos-mcp] policy_stale — 토큰 재발급 후 원 요청을 1회 재시도합니다\n');
  },
});

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

// 도구 실패는 예외로 던지지 않고 isError로 돌려준다. 모델이 이유를 읽고 다음 행동을 고를 수 있어야 한다.
// 다만 policy_stale 루프는 다르다 — 모델이 재시도해서 될 일이 아니므로 멈추라고 명시한다.
async function run(fn: () => Promise<unknown>, label: string): Promise<ToolResult> {
  try {
    return ok(`${label}: ${JSON.stringify(await fn())}`);
  } catch (err) {
    if (err instanceof PolicyStaleLoopError) {
      process.stderr.write(`[nomos-mcp] ${err.message}\n`);
      return {
        content: [
          {
            type: 'text',
            text: '경로 규칙이 계속 바뀌고 있어 작업을 멈춥니다. 재시도하지 말고 사람에게 알리세요.',
          },
        ],
        isError: true,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[nomos-mcp] ${label} failed: ${message}\n`);
    return { content: [{ type: 'text', text: `${label} failed: ${message}` }], isError: true };
  }
}

const server = new McpServer({ name: 'nomos', version: '0.1.0' });

server.registerTool(
  'claim_task',
  {
    title: 'Claim a task',
    description:
      'Claim a NOMOS task before doing any work on it. You must call this and get a success result before editing any file. Fails if someone else already claimed it, if its dependencies are not DONE, or if the task belongs to another team role.',
    inputSchema: { task_id: z.string().describe('The task id to claim') },
  },
  async ({ task_id }) => run(() => client.claimTask(task_id), 'claim_task'),
);

// submit_artifact가 push할 작업공간. Executor가 MCP 설정의 env로 넘긴다.
const workspaceDir = process.env.NOMOS_WORKSPACE_DIR ?? process.cwd();

type BriefingForPush = {
  task: { branchName: string | null };
  repo: { defaultBranch: string; devBranch: string };
};

server.registerTool(
  'submit_artifact',
  {
    title: 'Submit an artifact',
    description:
      'Submit finished work for a task you have claimed. Commit your work on the task branch first, then provide the commit sha and every path you changed. This tool pushes the task branch before submitting; if the push is refused (wrong branch, commit not on the task branch, remote has diverged) nothing is submitted and you get the reason. The server re-checks the paths against the ownership rules, so listing paths you did not change (or omitting ones you did) will be rejected or will fail verification later. If handover notes related to your task were published after you started, the submission is rejected with NOTES_UNACKNOWLEDGED and the notes are returned: read them, change and commit your work if they affect it, then submit again with their ids in acknowledged_note_ids. Notes that were already in your instructions are acknowledged automatically.',
    inputSchema: {
      task_id: z.string().describe('The claimed task id'),
      commit_sha: z.string().describe('Commit sha containing the work'),
      changed_paths: z.array(z.string()).describe('Repo-relative paths changed by this commit'),
      acknowledged_note_ids: z
        .array(z.string())
        .optional()
        .describe('Ids of handover notes you read after a NOTES_UNACKNOWLEDGED rejection'),
    },
  },
  async ({ task_id, commit_sha, changed_paths, acknowledged_note_ids }) =>
    run(async () => {
      // push할 브랜치와 막을 브랜치는 서버가 정한다. 모델이 넘긴 값으로 고르지 않는다.
      const briefing = (await client.getBriefing(task_id)) as unknown as BriefingForPush;
      const push = await pushTaskBranch({
        workspaceDir,
        commitSha: commit_sha,
        taskBranch: briefing.task.branchName,
        protectedBranches: [briefing.repo.defaultBranch, briefing.repo.devBranch],
      });
      if (!push.pushed) {
        process.stderr.write('[nomos-mcp] origin 없음 — push 건너뜀(서버가 mirror 모드로 로컬에서 읽는다)\n');
      }
      // push가 실패하면(PushRefused) 여기까지 오지 않는다 — 제출하지 않고 run()이 모델에게 사유를 돌려준다.
      // 브리핑으로 프롬프트에 들어간 노트는 이미 받은 것이다 — Executor가 작업공간에 남긴 id를 함께 보낸다.
      const acknowledgedNoteIds = mergeAcknowledged(readBriefingNoteIds(workspaceDir, task_id), acknowledged_note_ids);
      const artifact = await client.submitArtifact(task_id, {
        commitSha: commit_sha,
        changedPaths: changed_paths,
        ...(acknowledgedNoteIds.length === 0 ? {} : { acknowledgedNoteIds }),
      });
      return { ...artifact, push };
    }, 'submit_artifact'),
);

server.registerTool(
  'publish_note',
  {
    title: 'Publish a handover note',
    description:
      'Record what the next person needs to know about the task you claimed: what you implemented, what you decided, a gotcha you hit, or a deviation from the spec. This is a record, not a chat message — there is no reply and no recipient. Keep each key point to one short sentence; the server rejects notes that are too long instead of truncating them. Claims about another agent belong in raise_dispute, not here.',
    inputSchema: {
      task_id: z.string().describe('The claimed task id'),
      kind: z.enum(['IMPLEMENTED', 'DECIDED', 'GOTCHA', 'DEVIATION']).describe('Note kind'),
      headline: z.string().describe('One line, 60 characters or fewer'),
      key_points: z.array(z.string()).describe('1-5 points, each 120 characters or fewer'),
      affects: z
        .array(z.string())
        .optional()
        .describe('Paths this affects. Required for DEVIATION. May point outside your own paths'),
      supersedes: z.string().optional().describe('Note id this one corrects'),
    },
  },
  async ({ task_id, kind, headline, key_points, affects, supersedes }) =>
    run(
      () =>
        client.publishNote(task_id, {
          kind,
          headline,
          keyPoints: key_points,
          affects: affects ?? [],
          ...(supersedes === undefined ? {} : { supersedes }),
        }),
      'publish_note',
    ),
);

server.registerTool(
  'read_notes',
  {
    title: 'Read handover notes',
    description:
      'Read handover notes for the project. Notes relevant to your task are already in your prompt, so use this only when you need more — older notes, or notes for a different feature.',
    inputSchema: {
      project_id: z.string().describe('Project id'),
      spec_id: z.string().optional().describe('Only notes for this feature spec'),
      since_seq: z.number().optional().describe('Only notes after this sequence number'),
      limit: z.number().optional().describe('Up to 50, default 20'),
    },
  },
  async ({ project_id, spec_id, since_seq, limit }) =>
    run(
      () =>
        client.readNotes(project_id, {
          ...(spec_id === undefined ? {} : { specId: spec_id }),
          ...(since_seq === undefined ? {} : { sinceSeq: since_seq }),
          ...(limit === undefined ? {} : { limit }),
        }),
      'read_notes',
    ),
);

await server.connect(new StdioServerTransport());
process.stderr.write('[nomos-mcp] ready\n');
