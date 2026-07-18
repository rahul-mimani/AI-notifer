import { LmClient } from './llm/LmClient';

// Inside your activate function, alongside the existing command registrations:
const lmTestCmd = vscode.commands.registerCommand('ai-change-impact-notifier.testLmClient', async () => {
  const output = vscode.window.createOutputChannel('LmClient Test');
  output.show(true);
  
  const log = (msg: string) => {
    output.appendLine(`[${new Date().toISOString()}] ${msg}`);
  };

  try {
    log('=== LmClient End-to-End Test ===');
    
    const client = new LmClient();
    
    // Test 1: initialize
    log('Test 1: initialize()');
    await client.initialize();
    log('  ✓ initialize succeeded');
    
    // Test 2: complete (uncached)
    log('Test 2: complete() without cache');
    const t2Start = Date.now();
    const r1 = await client.complete('Reply with exactly the word: pong');
    log(`  ✓ Got response in ${Date.now() - t2Start}ms: "${r1.substring(0, 80)}"`);
    
    // Test 3: complete with cache — first call writes cache
    log('Test 3a: complete() with cacheKey (should call LLM and write cache)');
    const t3aStart = Date.now();
    const r2 = await client.complete('Say the word: apple', { cacheKey: 'test-apple' });
    log(`  ✓ First call in ${Date.now() - t3aStart}ms: "${r2.substring(0, 80)}"`);
    
    // Test 3b: same cacheKey should be instant (cache hit)
    log('Test 3b: complete() with same cacheKey (should hit cache — expect <50ms)');
    const t3bStart = Date.now();
    const r3 = await client.complete('DIFFERENT PROMPT — should be ignored due to cache', { cacheKey: 'test-apple' });
    const t3bMs = Date.now() - t3bStart;
    log(`  ✓ Second call in ${t3bMs}ms: "${r3.substring(0, 80)}"`);
    if (t3bMs > 500) {
      log('  ⚠ WARNING: cache lookup took >500ms, expected <50ms. Cache may not be working.');
    }
    if (r2 !== r3) {
      log('  ⚠ WARNING: cached response differs from first response. Cache is not returning the stored value.');
    }
    
    // Test 4: completeJson
    log('Test 4: completeJson()');
    const t4Start = Date.now();
    const parsed = await client.completeJson<{ answer: number }>(
      'Return a JSON object with a single field "answer" whose value is the number 42.'
    );
    log(`  ✓ Got parsed JSON in ${Date.now() - t4Start}ms: ${JSON.stringify(parsed)}`);
    if (parsed.answer !== 42) {
      log(`  ⚠ WARNING: expected answer=42, got ${parsed.answer}`);
    }
    
    // Test 5: cache path
    log('Test 5: getCachePath()');
    const cachePath = client.getCachePath();
    log(`  ✓ Cache path: ${cachePath}`);
    log(`  → Verify manually: this directory should contain test-apple.txt`);
    
    log('=== All tests completed ===');
    vscode.window.showInformationMessage('LmClient test complete — check the LmClient Test output channel.');
    
  } catch (err: any) {
    log(`✗ FAIL: ${err.message}`);
    log(`Stack: ${err.stack}`);
    vscode.window.showErrorMessage(`LmClient test failed: ${err.message}`);
  }
});
context.subscriptions.push(lmTestCmd);