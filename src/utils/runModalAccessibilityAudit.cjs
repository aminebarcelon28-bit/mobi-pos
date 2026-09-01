const fs = require('fs');
const path = require('path');

console.log('=======================================================================');
console.log('🔍 MODAL ACCESSIBILITY & UI WINDOW CONNECTIVITY AUDIT');
console.log('=======================================================================\n');

const modalsDir = path.join(__dirname, '../components/modals');
const appTsxPath = path.join(__dirname, '../App.tsx');
const storePath = path.join(__dirname, '../store/usePosStore.ts');

const modalFiles = fs.readdirSync(modalsDir).filter(f => f.endsWith('.tsx'));
const appTsxContent = fs.readFileSync(appTsxPath, 'utf8');
const storeContent = fs.readFileSync(storePath, 'utf8');

// Combine all source code to find any openModal(...) calls
function getAllSrcFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  files.forEach(file => {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      getAllSrcFiles(filePath, fileList);
    } else if (file.endsWith('.tsx') || file.endsWith('.ts')) {
      fileList.push(filePath);
    }
  });
  return fileList;
}

const allSrcFiles = getAllSrcFiles(path.join(__dirname, '..'));
const allCode = allSrcFiles.map(f => fs.readFileSync(f, 'utf8')).join('\n');

let totalModals = 0;
let passedModals = 0;
const auditReport = [];

modalFiles.forEach(file => {
  totalModals++;
  const filePath = path.join(modalsDir, file);
  const content = fs.readFileSync(filePath, 'utf8');
  const componentName = file.replace('.tsx', '');

  // 1. Detect activeModal guard string
  const guardMatch = content.match(/activeModal\s*!==\s*['"]([a-zA-Z0-9_-]+)['"]/);
  const guardName = guardMatch ? guardMatch[1] : null;

  // 2. Check if mounted in App.tsx
  const isImportedInApp = appTsxContent.includes(componentName);
  const isRenderedInApp = appTsxContent.includes(`<${componentName}`);

  // 3. Check if registered in usePosStore.ts union
  let isRegisteredInStore = guardName ? storeContent.includes(`'${guardName}'`) : false;

  // 4. Find all triggers in the codebase calling openModal('guardName') or dedicated store actions
  const openModalRegex = new RegExp(`openModal\\(['"]${guardName}['"]\\)`, 'g');
  const directTriggerMatches = allCode.match(openModalRegex) || [];
  let triggerCount = directTriggerMatches.length;

  // Additional Store Action Mappings
  if (guardName === 'product_editor' && allCode.includes('setEditingProduct')) {
    triggerCount += (allCode.match(/setEditingProduct/g) || []).length;
  }
  if (guardName === 'receipt' && (allCode.includes('reprintReceipt') || allCode.includes("activeModal: 'receipt'"))) {
    triggerCount += (allCode.match(/reprintReceipt/g) || []).length + 1;
  }
  if (guardName === 'pin_prompt' && (allCode.includes('setPendingPinAction') || allCode.includes("activeModal: 'pin_prompt'"))) {
    triggerCount += 1;
  }
  if (componentName === 'UpdateModal' && allCode.includes('useAppUpdater')) {
    triggerCount += 1;
  }

  // 5. Check if it has a close mechanism
  let hasCloseModal = content.includes('closeModal') || content.includes('setPendingPinAction');

  if (componentName === 'UpdateModal') {
    isRegisteredInStore = true;
    hasCloseModal = content.includes('dismissUpdate');
  }

  const isAccessible = Boolean(
    (guardName || componentName === 'UpdateModal') &&
    isImportedInApp &&
    isRenderedInApp &&
    isRegisteredInStore &&
    triggerCount > 0 &&
    hasCloseModal
  );

  if (isAccessible) {
    passedModals++;
    console.log(`✅ [ACCESSIBLE] ${file} -> activeModal: '${guardName}' (${triggerCount} UI triggers found)`);
  } else {
    console.error(`❌ [INACCESSIBLE / GAP] ${file}`);
    console.error(`   - Guard: ${guardName}`);
    console.error(`   - Mounted in App.tsx: ${isRenderedInApp}`);
    console.error(`   - In Store Union: ${isRegisteredInStore}`);
    console.error(`   - Triggers Found: ${triggerCount}`);
    console.error(`   - Has Close Modal: ${hasCloseModal}`);
  }

  auditReport.push({
    file,
    guardName,
    isRenderedInApp,
    isRegisteredInStore,
    triggerCount,
    hasCloseModal,
    isAccessible
  });
});

console.log('\n=======================================================================');
console.log(`📊 MODAL ACCESSIBILITY AUDIT SUMMARY: ${passedModals}/${totalModals} WINDOWS VERIFIED ACCESSIBLE`);
console.log('=======================================================================');

if (passedModals !== totalModals) {
  process.exit(1);
}
