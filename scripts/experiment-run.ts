// 무인 실험 감독 — 레포에서 돌리는 진입점. 본체·사용법은 src/executor/experiment-command.ts(CLI `nomos experiment`와 한 벌).
//   npm run experiment:run -- --project <id> --login <대표 loginId> --requirements <파일.json> --repeat 3 [--until 24]
// 상태 파일은 scripts/data/experiment-runs/<run>.json(커밋하지 않음).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { experimentCli } from '../src/executor/experiment-command.js';

const RUNS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'experiment-runs');

await experimentCli(process.argv.slice(2), { command: 'npm run experiment:run --', runsDir: RUNS_DIR });
