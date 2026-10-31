import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const run = (args, options = {}) => execFileSync('npm', args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });

function whoami() {
  try {
    return execFileSync('npm', ['whoami'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
  } catch {
    return '';
  }
}

const user = whoami();
if (!user) {
  console.error('未登录 npm。请先运行：npm login（或设置 NPM_TOKEN），然后再执行 npm run publish:now。');
  process.exit(1);
}

let published = '';
try {
  published = execFileSync('npm', ['view', pkg.name, 'version'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
} catch {
  published = '';
}
if (published === pkg.version) {
  console.error(`${pkg.name}@${pkg.version} 已经发布过，请先升版本。`);
  process.exit(1);
}

console.log(`准备发布 ${pkg.name}@${pkg.version}，账号：${user}`);
run(['publish', '--access', 'public']);
