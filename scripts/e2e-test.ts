#!/usr/bin/env npx tsx
/**
 * E2E test: exercises the real warming pipeline against actual sessions.
 * Discovers sessions, bootstraps scheduler, runs tick cycles, verifies updates.
 */
import { discoverSessions } from '../src/lib/sessions.js';
import { warmSession } from '../src/lib/warmer.js';
import { Scheduler } from '../src/lib/scheduler.js';
import { calcEstimatedWarmCost } from '../src/lib/pricing.js';
import type { Session } from '../src/lib/types.js';

const INTERVAL_MINUTES = 1; // 1 min for testing
const WARM_PROMPT = "Reply 'ok'";
const NUM_TICKS = 2;
const TICK_INTERVAL_MS = 15_000; // 15 seconds between ticks

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function printSession(s: Session) {
  const cached = s.cacheReadTokens + s.cacheWriteTokens;
  const warmCost = calcEstimatedWarmCost(cached, s.isWarm, s.model);
  console.log(
    `  ${s.isLive ? '●' : ' '} [${s.isWarm ? 'warm' : 'cold'}] ${s.sessionId.slice(0, 8)} ${s.name.slice(0, 40).padEnd(40)} ` +
    `cached=${cached.toLocaleString().padStart(8)} warmCount=${s.warmCount} ` +
    `warmCost=$${warmCost.toFixed(4)} next=${s.nextWarmAt ? new Date(s.nextWarmAt).toISOString() : '-'} ` +
    `status=${s.warmingStatus} lastErr=${s.lastWarmError || '-'}`
  );
}

async function main() {
  log('Discovering sessions...');
  const allSessions = discoverSessions('claude-sonnet-4-6');
  log(`Found ${allSessions.length} sessions total`);

  // Pick 2 live sessions for testing (they have valid session IDs)
  const liveSessions = allSessions.filter(s => s.isLive);
  log(`Found ${liveSessions.length} live sessions`);

  if (liveSessions.length < 2) {
    log(`ERROR: Need at least 2 live sessions for multi-session test. Found ${liveSessions.length}.`);
    log('Start more Claude Code sessions and retry.');
    process.exit(1);
  }

  const testSessions = liveSessions.slice(0, 2).map(s => ({ ...s, selected: true }));
  log(`Testing with ${testSessions.length} sessions:`);
  testSessions.forEach(printSession);

  // Bootstrap - force all sessions due immediately for testing
  log(`\nBootstrapping scheduler (interval=${INTERVAL_MINUTES}min)...`);
  const scheduler = new Scheduler(warmSession, INTERVAL_MINUTES);
  let sessions = scheduler.bootstrap(testSessions);
  // Override nextWarmAt to now so they warm on first tick
  sessions = sessions.map(s => ({ ...s, nextWarmAt: s.selected ? Date.now() : null }));
  log('After bootstrap (forced to now):');
  sessions.forEach(printSession);

  // Run tick cycles
  for (let tick = 1; tick <= NUM_TICKS; tick++) {
    // Wait for the earliest nextWarmAt or the tick interval
    const earliestNext = sessions
      .filter(s => s.nextWarmAt !== null)
      .reduce((min, s) => Math.min(min, s.nextWarmAt!), Infinity);

    const waitMs = earliestNext === Infinity
      ? TICK_INTERVAL_MS
      : Math.max(0, earliestNext - Date.now() + 1000); // +1s buffer

    log(`\n--- Tick ${tick}/${NUM_TICKS} - waiting ${Math.ceil(waitMs / 1000)}s for next warm ---`);
    await new Promise(r => setTimeout(r, waitMs));

    log(`Running tick...`);
    const before = sessions.map(s => ({ id: s.sessionId, warmCount: s.warmCount, cached: s.cacheReadTokens + s.cacheWriteTokens }));

    sessions = await scheduler.tick(sessions, WARM_PROMPT);

    log('After tick:');
    sessions.forEach(printSession);

    // Verify changes
    for (const s of sessions) {
      const prev = before.find(b => b.id === s.sessionId)!;
      const newCached = s.cacheReadTokens + s.cacheWriteTokens;

      if (s.warmCount > prev.warmCount) {
        log(`  CHECK: ${s.sessionId.slice(0, 8)} warmCount ${prev.warmCount} -> ${s.warmCount}`);
      }
      if (newCached !== prev.cached) {
        log(`  CHECK: ${s.sessionId.slice(0, 8)} cached ${prev.cached.toLocaleString()} -> ${newCached.toLocaleString()}`);
      }
      if (s.warmingStatus === 'error') {
        log(`  ERROR: ${s.sessionId.slice(0, 8)} failed: ${s.lastWarmError}`);
      }
    }
  }

  // Final summary
  log('\n=== E2E Test Summary ===');
  let allPassed = true;
  for (const s of sessions) {
    const cached = s.cacheReadTokens + s.cacheWriteTokens;
    log(`Session ${s.sessionId.slice(0, 8)}: warmCount=${s.warmCount} cached=${cached.toLocaleString()} status=${s.warmingStatus} nextWarmAt=${s.nextWarmAt ? 'set' : 'null'}`);

    if (s.warmCount === 0 && s.selected) {
      log(`  FAIL: warmCount is still 0 for a selected session`);
      allPassed = false;
    }
    if (s.nextWarmAt === null && s.selected) {
      log(`  FAIL: nextWarmAt is null for a selected session after warming`);
      allPassed = false;
    }
    if (s.warmingStatus === 'error') {
      log(`  FAIL: session has error status: ${s.lastWarmError}`);
      allPassed = false;
    }
  }

  if (allPassed) {
    log('\nAll checks PASSED');
  } else {
    log('\nSome checks FAILED');
    process.exit(1);
  }

  scheduler.stop();
}

main().catch(err => {
  console.error('E2E test crashed:', err);
  process.exit(1);
});
