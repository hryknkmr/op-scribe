// scripts/pii-guard.sh in a throwaway repository (#11).
// Secret-shaped strings and addresses are assembled at runtime so this file never holds one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'opscribe-guard-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'tester');
  git('config', 'user.email', 'tester@users.noreply.github.com');
  git('config', 'core.hooksPath', '/dev/null');
  mkdirSync(join(dir, 'scripts'));
  for (const f of ['pii-guard.sh', 'pii-guard.patterns.txt']) copyFileSync(join(ROOT, 'scripts', f), join(dir, 'scripts', f));
  writeFileSync(join(dir, 'r.txt'), 'ok\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const guard = (...args) => spawnSync('bash', ['scripts/pii-guard.sh', ...args], { cwd: dir, encoding: 'utf8' });
  return { dir, git, guard, write: (name, text) => writeFileSync(join(dir, name), text) };
}

const address = () => ['someone', '@', 'real-domain', '.example.net'].join('');

test('a rename that adds personal data is scanned (#11-1)', () => {
  const { git, guard, write } = repo();
  // Large enough that git still sees a rename (R), not a delete and an add.
  const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  write('r.txt', `${body}\n`);
  git('commit', '-q', '-am', 'grow');
  git('mv', 'r.txt', 'r2.txt');
  write('r2.txt', `${body}\n${address()}\n`);
  git('add', '-A');
  assert.match(git('diff', '--cached', '--name-status'), /^R/m);
  const r = guard('scan-staged');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /r2\.txt/);
});

test('token formats that shared/sanitize.js masks are detected too (#11-2)', () => {
  const tokens = [
    ['s', 'k-', 'A'.repeat(24)],
    ['AI', 'za', 'B'.repeat(33)],
    ['gh', 's_', 'C'.repeat(36)],
    ['gh', 'u_', 'D'.repeat(36)]
  ].map((parts) => parts.join(''));
  for (const token of tokens) {
    const { git, guard, write } = repo();
    write('t.txt', `key = ${token}\n`);
    git('add', '-A');
    assert.equal(guard('scan-staged').status, 1, token.slice(0, 4));
  }
});

test('ordinary words that contain the prefixes are not secrets', () => {
  const { git, guard, write } = repo();
  write('w.txt', 'task-runner-configuration-for-long-names\ndesk-organizer-with-many-drawers-and-shelves\n');
  git('add', '-A');
  assert.equal(guard('scan-staged').status, 0);
});

test('a push range with deletions only passes (#11-3)', () => {
  const { git, guard } = repo();
  git('rm', '-q', 'r.txt');
  git('commit', '-q', '-m', 'del');
  const r = guard('scan-range', 'HEAD~1', 'HEAD');
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('a range git cannot diff fails as an error, not as a finding', () => {
  const { guard } = repo();
  const r = guard('scan-range', 'no-such-ref', 'HEAD');
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /✗ push 範囲/);
});

test('non-ASCII file names are scanned whatever core.quotepath is (#11-4)', () => {
  for (const quotepath of ['true', 'false']) {
    const { git, guard, write } = repo();
    git('config', 'core.quotepath', quotepath);
    write('日本語.txt', 'ok\n');
    git('add', '-A');
    assert.equal(guard('scan-staged').status, 0, `clean, quotepath=${quotepath}`);
    write('日本語.txt', `${address()}\n`);
    git('add', '-A');
    const r = guard('scan-staged');
    assert.equal(r.status, 1, `dirty, quotepath=${quotepath}: ${r.stderr}`);
    assert.match(r.stdout, /日本語\.txt/);
  }
});

test('content added in one commit and removed in a later one is found commit by commit (#12-1)', () => {
  const { git, guard, write } = repo();
  write('a.txt', `${address()}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'add');
  write('a.txt', 'ok\n');
  write('b.txt', 'unrelated\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'remove');
  assert.equal(guard('scan-range', 'HEAD~2', 'HEAD').status, 0, 'the summed diff hides it');
  const r = guard('scan-commits', 'HEAD~2..HEAD');
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /の追加内容/);
});

test('commit messages are scanned (#12-2)', () => {
  const { git, guard } = repo();
  git('commit', '-q', '--allow-empty', '-m', `ask ${address()}`);
  const r = guard('scan-commits', 'HEAD~1..HEAD');
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /コミットメッセージ/);
});

test('the root commit is scanned when the whole history is given', () => {
  const { dir, guard, write } = repo();
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('checkout', '-q', '--orphan', 'fresh');
  write('r.txt', `${address()}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'root');
  assert.equal(guard('scan-commits', 'HEAD').status, 1);
  assert.equal(guard('scan-commits', 'no-such-ref').status, 2);
});

test('only the exact co-author address is allowed on that domain', () => {
  const domain = ['anthropic', 'com'].join('.');
  const { git, guard, write } = repo();
  write('ok.txt', `Co-Authored-By: Claude <noreply@${domain}>\n`);
  git('add', '-A');
  assert.equal(guard('scan-staged').status, 0);
  for (const local of ['someone', 'x.noreply']) {
    write('ok.txt', `${local}@${domain}\n`);
    git('add', '-A');
    assert.equal(guard('scan-staged').status, 1, local);
  }
});
