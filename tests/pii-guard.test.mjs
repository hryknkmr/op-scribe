// scripts/pii-guard.sh in a throwaway repository (#11).
// Secret-shaped strings and addresses are assembled at runtime so this file never holds one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, mkdirSync, copyFileSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run inside a git hook, the tests inherit GIT_DIR and GIT_INDEX_FILE, which point at the real
// repository when it is a worktree: every git below would then init, configure and commit there
// instead of in its scratch directory. The scratch repositories are their own.
for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];

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
  assert.equal(guard('scan-range', 'HEAD~2', 'HEAD').status, 1, 'the push check goes commit by commit too');
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

test('the co-author exception covers the trailer form, not the address', () => {
  const domain = ['anthropic', 'com'].join('.');
  const trailer = `Co-Authored-By: Claude <noreply@${domain}>`;
  const { git, guard, write } = repo();
  write('ok.txt', `${trailer}\n`);
  git('add', '-A');
  assert.equal(guard('scan-staged').status, 0);
  assert.equal(guard('scan-tree').status, 0);
  git('commit', '-q', '--allow-empty', '-m', `message\n\n${trailer}\nCo-Authored-By: Claude Opus 5.5 <noreply@${domain}>`);
  assert.equal(guard('scan-commits', 'HEAD~1..HEAD').status, 0);
  const lines = [
    `noreply@${domain}`,
    `someone@${domain}`,
    `Co-Authored-By: Claude <x.noreply@${domain}>`,
    `Co-Authored-By: Some Person <noreply@${domain}>`,
    `Co-Authored-By: Claude Person <noreply@${domain}>`,
    `see ${trailer}`,
    `Co-Authored-By: ${address()} <noreply@${domain}>`,
    `${trailer} ${address()}`
  ];
  for (const line of lines) {
    write('ok.txt', `${line}\n`);
    git('add', '-A');
    assert.equal(guard('scan-staged').status, 1, line);
    assert.equal(guard('scan-tree').status, 1, line);
  }
});

test('a range git cannot read is an error for identity and push checks', () => {
  const { guard } = repo();
  assert.equal(guard('check-identities', 'no-such-ref..HEAD').status, 2);
  assert.equal(guard('scan-range', 'no-such-ref', 'HEAD').status, 2);
});

test('a push from the root compares with the empty tree, as pre-push does', () => {
  const { git, guard } = repo();
  const empty = git('hash-object', '-t', 'tree', '/dev/null').trim();
  const r = guard('scan-range', empty, 'HEAD');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  git('config', 'user.email', address());
  git('commit', '-q', '--allow-empty', '-m', 'bad identity');
  assert.equal(guard('scan-range', empty, 'HEAD').status, 1);
});

test('a malformed pattern stops every scan instead of finding nothing', () => {
  const { dir, git, guard, write } = repo();
  write('t.txt', `${address()}\n`);
  git('add', '-A');
  writeFileSync(join(dir, 'scripts', 'pii-guard.patterns.local.txt'), '(\n');
  for (const args of [['scan-tree'], ['scan-staged'], ['scan-commits', 'HEAD']]) {
    const r = guard(...args);
    assert.equal(r.status, 2, args[0]);
    assert.match(r.stderr, /パターンに誤り/);
  }
});

test('the wording of the exception in AGENTS.md passes', () => {
  const domain = ['anthropic', 'com'].join('.');
  const { git, guard, write } = repo();
  write('a.md', `共著者行（\`Co-Authored-By: … <noreply@${domain}>\`）は対象外\n`);
  git('add', '-A');
  assert.equal(guard('scan-tree').status, 0);
});

test('the guard itself is scanned', () => {
  const { dir, git, guard } = repo();
  appendFileSync(join(dir, 'scripts', 'pii-guard.sh'), `# ${address()}\n`);
  git('add', '-A');
  assert.equal(guard('scan-staged').status, 1);
});

test('a message with only comment lines passes', () => {
  const { dir, guard } = repo();
  const file = join(dir, 'msg.txt');
  writeFileSync(file, '# comment\n');
  assert.equal(guard('scan-message', file).status, 0);
});

test('a file name with a newline is scanned', () => {
  const { git, guard, write } = repo();
  write('a\nb.txt', 'ok\n');
  git('add', '-A');
  assert.equal(guard('scan-staged').status, 0);
  write('a\nb.txt', `${address()}\n`);
  git('add', '-A');
  assert.equal(guard('scan-staged').status, 1);
  assert.equal(guard('scan-tree').status, 1);
});

test('a value split by a newline in a file name is still found', () => {
  const value = address();
  const name = `${value.slice(0, 4)}\n${value.slice(4)}.txt`;
  const { git, guard, write } = repo();
  write(name, '');
  git('add', '-A');
  assert.equal(guard('scan-staged').status, 1);
  assert.equal(guard('scan-tree').status, 1);
  git('commit', '-q', '-m', 'add');
  assert.equal(guard('scan-commits', 'HEAD~1..HEAD').status, 1);
});

test('a file name with bytes that are not UTF-8 does not stop the scan', () => {
  const { dir, guard } = repo();
  // In the index only: some file systems refuse such a name.
  execFileSync('bash', ['-c', `git update-index --add --cacheinfo 100644,$(git rev-parse HEAD:r.txt),$'x\\xff.txt'`], { cwd: dir });
  assert.equal(guard('scan-staged').status, 0);
  assert.equal(guard('scan-tree').status, 0);
});

const hook = (dir, name, args = [], input = '') =>
  spawnSync('bash', [join(ROOT, '.githooks', name), ...args], { cwd: dir, input, encoding: 'utf8' });

test('every hook stops when the guard is missing', () => {
  const { dir } = repo();
  rmSync(join(dir, 'scripts', 'pii-guard.sh'));
  const msg = join(dir, 'msg.txt');
  writeFileSync(msg, 'subject\n');
  assert.equal(hook(dir, 'pre-commit').status, 1);
  assert.equal(hook(dir, 'commit-msg', [msg]).status, 1);
  assert.equal(hook(dir, 'pre-push', ['origin', 'https://example.com/r.git'], 'x\n').status, 1);
});

test('pre-push scans a new branch that only another remote already has', () => {
  const { dir, git, write } = repo();
  write('a.txt', `${address()}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'add');
  const sha = git('rev-parse', 'HEAD').trim();
  git('update-ref', 'refs/remotes/other/main', sha);
  const input = `refs/heads/main ${sha} refs/heads/main ${'0'.repeat(40)}\n`;
  const r = hook(dir, 'pre-push', ['origin', 'https://example.com/r.git'], input);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(hook(dir, 'pre-push', ['other', 'https://example.com/r.git'], input).status, 0);
});

test('binary content added and then removed is found commit by commit', () => {
  const { dir, git, guard } = repo();
  writeFileSync(join(dir, 'b.bin'), Buffer.concat([Buffer.from([0, 1, 255, 254, 10]), Buffer.from(`${address()}\n`)]));
  git('add', '-A');
  git('commit', '-q', '-m', 'add');
  git('rm', '-q', 'b.bin');
  git('commit', '-q', '-m', 'remove');
  assert.equal(guard('scan-tree').status, 0);
  assert.equal(guard('scan-commits', 'HEAD~2..HEAD').status, 1);
});

test('file names are scanned at every stage', () => {
  const name = `${address()}.txt`;
  const { git, guard, write } = repo();
  write(name, '');
  git('add', '-A');
  assert.equal(guard('scan-staged').status, 1);
  assert.equal(guard('scan-tree').status, 1);
  git('commit', '-q', '-m', 'add');
  git('rm', '-q', name);
  git('commit', '-q', '-m', 'remove');
  assert.equal(guard('scan-tree').status, 0);
  assert.equal(guard('scan-commits', 'HEAD~2..HEAD').status, 1);
});

test('only users.noreply is allowed on the GitHub noreply domain', () => {
  const domain = ['noreply', 'github', 'com'].join('.');
  const { git, guard, write } = repo();
  write('a.txt', `someone@${domain}\n`);
  git('add', '-A');
  assert.equal(guard('scan-staged').status, 1);
});

for (const flags of ['-anoE', '-ainEi', '-viE']) {
  test(`grep ${flags} failing during a scan is an error, not a clean result`, () => {
    const { git, write, dir, guard } = repo();
    write('a.txt', `${address()}\n`);
    git('add', '-A');
    git('commit', '-q', '-m', 'add');
    const bin = mkdtempSync(join(tmpdir(), 'opscribe-shim-'));
    const real = execFileSync('bash', ['-c', 'command -v grep'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'grep'), `#!/bin/bash\n[[ "$1" == "${flags}" ]] && exit 2\nexec ${real} "$@"\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    write('a.txt', `${address()} changed\n`);
    git('add', '-A');
    for (const args of [['scan-range', 'HEAD~1', 'HEAD'], ['scan-commits', 'HEAD~1..HEAD'], ['scan-staged']]) {
      const r = spawnSync('bash', ['scripts/pii-guard.sh', ...args], { cwd: dir, encoding: 'utf8', env });
      assert.equal(r.status, 2, `${args[0]}: ${r.stdout}${r.stderr}`);
    }
    assert.equal(guard('scan-staged').status, 1);
  });
}

test('a git hook\'s GIT_DIR never reaches the scratch repositories (review of #28)', () => {
  // A repository standing in for the one a worktree commit runs the hook in.
  const victim = mkdtempSync(join(tmpdir(), 'opscribe-victim-'));
  execFileSync('git', ['init', '-q', '-b', 'main', victim]);
  writeFileSync(join(victim, 'v.txt'), 'v\n');
  execFileSync('git', ['-C', victim, 'add', 'v.txt']);
  const gitDir = join(victim, '.git');
  const before = { config: readFileSync(join(gitDir, 'config'), 'utf8'), index: readFileSync(join(gitDir, 'index')) };
  // The child's scratch repositories go here, so the test can see that they were made.
  const scratch = mkdtempSync(join(tmpdir(), 'opscribe-scratch-'));
  const env = { ...process.env, GIT_DIR: gitDir, GIT_INDEX_FILE: join(gitDir, 'index'), TMPDIR: scratch };
  // A test run of its own, not a subtest of this one.
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', '--test-name-pattern=^a rename that adds personal data', fileURLToPath(import.meta.url)],
    { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // The scratch test ran, in a repository of its own: it made one and committed there.
  const made = readdirSync(scratch).filter((name) => name.startsWith('opscribe-guard-'));
  assert.equal(made.length, 1, readdirSync(scratch).join(', '));
  assert.equal(spawnSync('git', ['-C', join(scratch, made[0]), 'rev-parse', '--verify', '-q', 'HEAD'], { encoding: 'utf8' }).status, 0);
  // ... and the repository the hook pointed at is as it was.
  assert.equal(readFileSync(join(gitDir, 'config'), 'utf8'), before.config);
  assert.ok(readFileSync(join(gitDir, 'index')).equals(before.index), 'its index is as it was');
  assert.equal(spawnSync('git', ['-C', victim, 'rev-parse', '--verify', '-q', 'HEAD'], { encoding: 'utf8' }).status, 1, 'no commit was made there');
});
