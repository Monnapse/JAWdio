const fs = require('fs');
const path = require('path');

const projectRoot = process.cwd();
const standaloneRoot = path.join(projectRoot, '.next', 'standalone');
const standaloneNextRoot = path.join(standaloneRoot, '.next');
const publicSource = path.join(projectRoot, 'public');
const publicTarget = path.join(standaloneRoot, 'public');
const staticSource = path.join(projectRoot, '.next', 'static');
const staticTarget = path.join(standaloneNextRoot, 'static');
const pathsToPrune = [
  path.join(standaloneRoot, 'dist'),
  path.join(standaloneRoot, 'src'),
  path.join(standaloneRoot, 'scripts'),
  path.join(standaloneRoot, 'README.md'),
  path.join(standaloneRoot, 'eslint.config.mjs'),
  path.join(standaloneRoot, 'next.config.ts'),
  path.join(standaloneRoot, 'postcss.config.mjs'),
  path.join(standaloneRoot, 'tsconfig.json'),
  path.join(standaloneRoot, 'tsconfig.tsbuildinfo'),
  path.join(standaloneRoot, 'package-lock.json'),
];
const excludedPublicPaths = new Set([
  path.join(publicSource, 'clips'),
  path.join(publicSource, 'sounds'),
  path.join(publicSource, 'temp_handoff.webm'),
]);

const assertPathExists = (targetPath, label) => {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${label} is missing at ${targetPath}. Run the Next build first.`);
  }
};

const shouldSkipPath = (sourcePath) => {
  for (const excludedPath of excludedPublicPaths) {
    if (sourcePath === excludedPath || sourcePath.startsWith(`${excludedPath}${path.sep}`)) {
      return true;
    }
  }

  return false;
};

const copyDirectory = (sourceDir, targetDir, options = {}) => {
  const { skip } = options;

  if (!fs.existsSync(sourceDir)) {
    return;
  }

  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (skip?.(sourcePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath, options);
      continue;
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
};

assertPathExists(standaloneRoot, 'Standalone build output');
assertPathExists(staticSource, 'Next static assets');
assertPathExists(publicSource, 'Public assets');

for (const targetPath of pathsToPrune) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

fs.mkdirSync(standaloneNextRoot, { recursive: true });
copyDirectory(staticSource, staticTarget);
copyDirectory(publicSource, publicTarget, { skip: shouldSkipPath });

console.log('Prepared Electron bundle assets in .next/standalone');
