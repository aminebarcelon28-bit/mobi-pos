import { runBusinessLogicTests } from './businessLogic.test';
import { runLoyaltyEngineTests } from './loyaltyEngine.test';

console.log('==============================================');
console.log('RUNNING BUSINESS LOGIC & FINANCIAL TEST SUITE');
console.log('==============================================');

const { success, results } = runBusinessLogicTests();
results.forEach((r) => console.log(r));

console.log('\n==============================================');
console.log('RUNNING LOYALTY ENGINE TEST SUITE');
console.log('==============================================');
const { passed, failed } = runLoyaltyEngineTests();

console.log('----------------------------------------------');
if (success && failed === 0) {
  console.log(`SUCCESS: ALL BUSINESS LOGIC & LOYALTY TESTS PASSED! (${passed} loyalty tests)`);
} else {
  console.log('FAILURE: SOME TESTS FAILED!');
}
console.log('==============================================');
