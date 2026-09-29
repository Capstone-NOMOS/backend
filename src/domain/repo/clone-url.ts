import path from 'node:path';
import { AppError } from '../../errors.js';

// repos.clone_url 검증. 이 값은 서버가 `git clone --mirror <값>`에 그대로 넘긴다(mirror 모드 V3).
// 수정 가능하게 여는 순간 이 검증이 보안 경계다.
//
// 모드(COMMIT_INSPECTOR)에 따라 받는 범위가 다르다.
//   github (운영)  https://github.com/owner/repo 만. 로컬 경로·file://를 받으면 운영 서버 파일시스템의
//                 다른 git 저장소(다른 조직의 mirror 포함)를 읽을 수 있다. 다른 호스트도 받지 않는다.
//   mirror (로컬)  https://(자격 증명 없이), file:///절대경로, 로컬 절대 경로
//
// 모드와 무관하게 막는 것과 이유:
//   -로 시작          git이 옵션으로 읽는다. --upload-pack=<명령>은 서버에서 임의 명령을 실행한다.
//   ext::, fd::       git 원격 헬퍼가 명령을 실행한다.
//   ssh://, git@...   서버에 SSH 키를 두지 않는다 — 두면 그 키가 곧 모든 레포의 자격 증명이다.
//   http://           평문이다.
//   user:pass@        자격 증명이 DB·이벤트(REPO_UPDATED)·에러 메시지에 남는다. events는 지워지지 않는다.
//   상대 경로         서버의 작업 디렉터리에 따라 뜻이 바뀐다.
export type CloneUrlMode = 'github' | 'mirror';

const ALLOWED: Record<CloneUrlMode, string> = {
  github: 'https://github.com/owner/repo 형태만 받는다(COMMIT_INSPECTOR=github)',
  mirror: 'https://host/owner/repo.git(자격 증명 없이) 또는 로컬 절대 경로만 받는다(COMMIT_INSPECTOR=mirror)',
};

export function validateCloneUrl(raw: string, mode: CloneUrlMode): string {
  const invalid = (message: string): AppError =>
    new AppError('VALIDATION_ERROR', `clone_url ${message} — ${ALLOWED[mode]}`);

  const value = raw.trim();
  if (value === '') throw invalid('이 비어 있다');
  if (value.startsWith('-')) throw invalid('이 -로 시작한다(git 옵션으로 읽힌다)');
  if (/[\r\n\0]/.test(value)) throw invalid('에 제어 문자가 있다');

  // 로컬 절대 경로 (Windows 드라이브 경로 포함). URL 스킴이 아니다.
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    if (mode === 'github') throw invalid('가 로컬 경로다(운영 서버의 파일시스템을 가리키게 된다)');
    return value;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // git@github.com:owner/repo.git 같은 scp 형식도 여기로 온다.
    throw invalid('가 URL도 절대 경로도 아니다(scp 형식 git@host:path는 받지 않는다)');
  }

  if (url.protocol === 'file:') {
    if (mode === 'github') throw invalid('가 file:// 경로다(운영 서버의 파일시스템을 가리키게 된다)');
    return value;
  }
  if (url.protocol !== 'https:') throw invalid(`의 스킴(${url.protocol})은 받지 않는다`);
  if (url.username !== '' || url.password !== '') throw invalid('에 자격 증명(user:pass@)을 넣을 수 없다');
  if (url.hostname === '') throw invalid('에 호스트가 없다');

  if (mode === 'github') {
    // URL 파서가 호스트를 소문자로 정규화하므로 GITHUB.com도 여기서 같게 본다.
    // 접두 문자열 비교가 아니라 호스트 일치로 본다 — https://github.com.evil.com/ 은 접두어로는 통과한다.
    if (url.hostname !== 'github.com' || url.port !== '') throw invalid(`의 호스트(${url.host})가 github.com이 아니다`);
    if (url.pathname.split('/').filter(Boolean).length < 2) throw invalid('에 owner/repo 경로가 없다');
  }
  return value;
}
