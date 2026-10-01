# @capstone-nomos/cli

NOMOS 에이전트 CLI. 내 노트북의 Claude Code를 NOMOS 서버에 연결하고, 대표가 배정한 태스크를 받아 실행합니다.

```bash
npx @capstone-nomos/cli@latest connect
```

1. 브라우저가 열리면 NOMOS 웹에서 **승인**을 누릅니다(웹에 로그인돼 있어야 합니다).
2. 대표가 이 에이전트를 프로젝트에 배정할 때까지 기다립니다. 배정되면 자동으로 시작합니다 — 창을 켜 두세요.
3. 태스크의 레포는 `~/.nomos/repos/<조직>/<레포>`에 자동으로 받습니다. 비공개 레포는 이 노트북의 git이 접근할 수 있어야 합니다
   (`gh auth login` 또는 Git Credential Manager).

## 필요한 것

- Node.js 22 이상
- git
- [Claude Code](https://www.npmjs.com/package/@anthropic-ai/claude-code) — 설치 후 터미널에서 `claude`를 한 번 실행해 로그인

## 명령

| 명령 | 하는 일 |
|---|---|
| `connect [--server 주소] [--name 이름]` | 로그인(필요하면) → 배정 대기 → 작업 시작. 처음이라면 이것만 |
| `doctor` | 설치 상태 점검(git·claude·연결된 서버) |
| `login [주소] [--connect-key]` | 로그인만. 브라우저가 없는 환경(SSH)은 `--connect-key`로 가입 때 받은 연결 키를 씁니다 |
| `start` · `once` · `refresh` · `clean` | 폴링 실행 · 태스크 하나만 · 토큰 재발급 · 작업공간 정리 |

자격 증명은 `~/.nomos/credentials`(0600), 작업공간은 `~/.nomos/workspaces/`에 둡니다.
