// 도메인 ID를 문자열 그대로 섞어 쓰지 못하게 막는 브랜디드 타입.
// (orgId: string, repoId: string) 같은 시그니처는 인자 순서가 바뀌어도 컴파일이 통과하지만,
// 브랜드가 다르면 타입 에러가 난다.
type Brand<T, B extends string> = T & { readonly __brand: B };

export type OrgId = Brand<string, 'OrgId'>;
export type UserId = Brand<string, 'UserId'>;
export type RepoId = Brand<string, 'RepoId'>;
export type RepoPathId = Brand<string, 'RepoPathId'>;
export type InviteId = Brand<string, 'InviteId'>;
export type AgentId = Brand<string, 'AgentId'>;

// UUID 문자열을 각 브랜드 타입으로 표시(cast)하는 헬퍼. 값 자체는 바뀌지 않는다.
export const asOrgId = (id: string): OrgId => id as OrgId;
export const asUserId = (id: string): UserId => id as UserId;
export const asRepoId = (id: string): RepoId => id as RepoId;
export const asRepoPathId = (id: string): RepoPathId => id as RepoPathId;
export const asInviteId = (id: string): InviteId => id as InviteId;
export const asAgentId = (id: string): AgentId => id as AgentId;
