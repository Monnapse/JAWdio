const fs = require('fs');
const path = require('path');

const projectRoot = process.cwd();
const pathsToRemove = [
  path.join(projectRoot, 'dist'),
  path.join(projectRoot, '.next', 'standalone', 'dist'),
  path.join(projectRoot, '.next', 'standalone', 'src'),
  path.join(projectRoot, '.next', 'standalone', 'scripts'),
];

for (const targetPath of pathsToRemove) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

console.log('Cleaned previous build artifacts');
