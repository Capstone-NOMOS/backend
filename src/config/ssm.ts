import { GetParametersByPathCommand, SSMClient } from '@aws-sdk/client-ssm';

// 운영 비밀값(JWT_SECRET, DATABASE_URL, GITHUB_CLIENT_SECRET, ...)은 SSM Parameter Store에 둔다.
// 서버에 .env 파일을 올리지 않는다 — 파일은 이미지·백업·로그 어디로든 새어 나간다.
//
// 이 모듈은 **env.ts보다 먼저** 돌아야 한다. env.ts는 import 시점에 process.env를 검증하므로
// 여기서 값을 채운 뒤에 import해야 한다(boot.ts가 순서를 지킨다). 같은 이유로 env.ts·logger를 import하지 않는다.
//
// 파라미터 이름의 마지막 조각이 환경변수 이름이다: /nomos/prod/JWT_SECRET → JWT_SECRET.
// 이미 설정된 환경변수는 덮어쓰지 않는다 — .env 로더(loadEnvFile)와 같은 규칙이고, 장애 때
// `docker run -e`로 값 하나만 바꿔 띄울 수 있다.

export type SsmLike = {
  send(command: GetParametersByPathCommand): Promise<{
    Parameters?: { Name?: string; Value?: string }[];
    NextToken?: string;
  }>;
};

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

// 적재한 이름 목록을 돌려준다. 값은 절대 돌려주지도 찍지도 않는다.
export async function loadParametersFromSsm(
  path: string,
  client: SsmLike = new SSMClient({}) as unknown as SsmLike,
  target: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const prefix = path.endsWith('/') ? path : `${path}/`;
  const loaded: string[] = [];
  let nextToken: string | undefined;

  do {
    const page = await client.send(
      new GetParametersByPathCommand({
        Path: prefix,
        Recursive: false,
        // SecureString을 복호화해서 받는다. aws/ssm 관리형 키는 SSM 권한만 있으면 풀린다.
        WithDecryption: true,
        MaxResults: 10,
        NextToken: nextToken,
      }),
    );
    for (const p of page.Parameters ?? []) {
      if (!p.Name || p.Value === undefined) continue;
      const name = p.Name.slice(prefix.length);
      // 이름이 환경변수 형식이 아니면 무시하지 않고 멈춘다. 오타가 조용히 빠지면 기본값으로 돈다.
      if (!ENV_NAME.test(name)) throw new Error(`SSM parameter "${p.Name}" is not a valid env var name`);
      if (target[name] === undefined) {
        target[name] = p.Value;
        loaded.push(name);
      }
    }
    nextToken = page.NextToken;
  } while (nextToken);

  return loaded;
}
