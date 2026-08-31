import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolve } from 'path';

// Get target version from command line argument
const versionArg = process.argv[2];

if (!versionArg) {
  console.error('❌ Error: Please specify a version. Example: npm run release 1.3.3');
  process.exit(1);
}

// Format version string (ensure 'v' prefix is stripped if provided)
const targetVersion = versionArg.startsWith('v') ? versionArg.slice(1) : versionArg;
const tagName = `v${targetVersion}`;

console.log(`🚀 Starting production release pipeline for ${tagName}...`);

try {
  // 1. Ensure working directory is clean
  const gitStatus = execSync('git status --porcelain', { encoding: 'utf-8' }).trim();
  if (gitStatus) {
    console.log('📦 Staging uncommitted changes...');
    execSync('git add .', { stdio: 'inherit' });
  }

  // 2. Update package.json
  const pkgPath = resolve('package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  pkg.version = targetVersion;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`  ✓ Updated package.json to ${targetVersion}`);

  // 3. Update tauri.conf.json
  const tauriPath = resolve('src-tauri/tauri.conf.json');
  const tauriConf = JSON.parse(readFileSync(tauriPath, 'utf-8'));
  tauriConf.version = targetVersion;
  writeFileSync(tauriPath, JSON.stringify(tauriConf, null, 2) + '\n');
  console.log(`  ✓ Updated src-tauri/tauri.conf.json to ${targetVersion}`);

  // 4. Update Cargo.toml
  const cargoPath = resolve('src-tauri/Cargo.toml');
  let cargoContent = readFileSync(cargoPath, 'utf-8');
  cargoContent = cargoContent.replace(/^version = ".*?"/m, `version = "${targetVersion}"`);
  writeFileSync(cargoPath, cargoContent);
  console.log(`  ✓ Updated src-tauri/Cargo.toml to ${targetVersion}`);

  // 5. Update src/types/pos.ts APP_VERSION
  const posTypesPath = resolve('src/types/pos.ts');
  let posTypesContent = readFileSync(posTypesPath, 'utf-8');
  posTypesContent = posTypesContent.replace(/export const APP_VERSION = '.*?';/, `export const APP_VERSION = '${targetVersion}';`);
  writeFileSync(posTypesPath, posTypesContent);
  console.log(`  ✓ Updated src/types/pos.ts to ${targetVersion}`);

  // 5. Git Commit
  console.log('📌 Creating release commit...');
  execSync('git add .', { stdio: 'inherit' });
  execSync(`git commit -m "chore(release): ${tagName}"`, { stdio: 'inherit' });

  // 6. Git Annotated Tag
  console.log(`🏷️ Creating annotated Git tag ${tagName}...`);
  execSync(`git tag -a ${tagName} -m "Release ${tagName}"`, { stdio: 'inherit' });

  // 7. Push atomically to Remote
  console.log('⬆️ Pushing commits and tags to GitHub remote...');
  execSync('git push origin main --follow-tags', { stdio: 'inherit' });

  console.log(`\n✅ Release ${tagName} successfully pushed to GitHub!`);
  console.log(`📡 GitHub Actions CI/CD will now build and publish the release package.`);

} catch (error) {
  console.error('\n❌ Release failed:', error.message);
  process.exit(1);
}
