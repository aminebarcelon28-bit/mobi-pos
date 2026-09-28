const fs = require('fs');
const readline = require('readline');

async function findWrites() {
  const fileStream = fs.createReadStream('C:\\Users\\Click\\.gemini\\antigravity\\brain\\a3b39aaa-4a99-4d57-b19a-9e4631eab6bf\\.system_generated\\logs\\transcript_full.jsonl');
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let lineNum = 0;
  for await (const line of rl) {
    lineNum++;
    if (line.includes('TargetFile') && line.includes('sqlPluginAdapter.ts')) {
      const obj = JSON.parse(line);
      console.log('Line', lineNum, 'step:', obj.step_index);
      for (const tc of obj.tool_calls || []) {
        console.log('  tool:', tc.name, tc.args?.Description);
      }
    }
  }
}
findWrites();
