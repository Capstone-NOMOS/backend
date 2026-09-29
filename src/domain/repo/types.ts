import type { RepoId, RepoPathId } from '../ids.js';
import type { TeamRole } from '../roles.js';
import type { PathAccess } from './seed-paths.js';

export type OwnerRole = TeamRole;
export type PathSource = 'seed' | 'scan' | 'manual';

export type RepoPath = {
  id: RepoPathId;
  repoId: RepoId;
  pathPattern: string;
  ownerRole: OwnerRole | null;
  access: PathAccess;
  actionKey: string | null;
  priority: number;
  source: PathSource;
  createdAt: string;
};
