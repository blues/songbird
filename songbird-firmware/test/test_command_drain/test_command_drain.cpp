/**
 * @file test_command_drain.cpp
 * @brief Native tests for the CommandTask per-poll drain-loop logic (M7)
 *
 * CommandTask must drain command.qi within a bounded budget rather than
 * processing a single command per poll. This re-implements the drain-loop
 * control flow (get-until-empty, capped at COMMAND_DRAIN_MAX_PER_POLL) against
 * a mock command source, avoiding the FreeRTOS/I2C hardware dependencies in
 * SongbirdTasks.cpp while exercising the same branch logic.
 */

#include <unity.h>
#include "native_stubs.h"
#include "SongbirdConfig.h"

// ---------------------------------------------------------------------------
// Mock command source: models notecardGetCommand() returning one note per call
// and returning false once command.qi is empty.
// ---------------------------------------------------------------------------
static int s_available;    // commands still queued in the mock
static int s_getCalls;     // number of times the mock getter was invoked

static bool mockGetCommand(void) {
    s_getCalls++;
    if (s_available > 0) {
        s_available--;
        return true;
    }
    return false;
}

// Re-implementation of the CommandTask drain loop. Returns the number of
// commands actually processed this poll. Mirrors the production loop:
//   for (drained = 0; drained < MAX; drained++) {
//       if (!getCommand()) break;
//       ...execute...
//   }
static int drainCommands(int maxPerPoll) {
    int processed = 0;
    for (int drained = 0; drained < maxPerPoll; drained++) {
        if (!mockGetCommand()) {
            break;
        }
        processed++;
    }
    return processed;
}

void setUp(void) {
    s_available = 0;
    s_getCalls = 0;
}
void tearDown(void) {}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// An empty queue processes nothing and makes exactly one probe.
void test_drain_empty_queue_processes_none(void) {
    s_available = 0;
    int processed = drainCommands(COMMAND_DRAIN_MAX_PER_POLL);
    TEST_ASSERT_EQUAL_INT(0, processed);
    TEST_ASSERT_EQUAL_INT(1, s_getCalls);  // one probe, then break
}

// A backlog smaller than the budget drains fully in a single poll.
void test_drain_backlog_below_budget_drains_all(void) {
    s_available = 3;
    int processed = drainCommands(COMMAND_DRAIN_MAX_PER_POLL);
    TEST_ASSERT_EQUAL_INT(3, processed);
    // 3 successful gets + 1 empty get that breaks the loop
    TEST_ASSERT_EQUAL_INT(4, s_getCalls);
}

// A backlog larger than the budget is capped at COMMAND_DRAIN_MAX_PER_POLL.
void test_drain_respects_max_per_poll_cap(void) {
    s_available = COMMAND_DRAIN_MAX_PER_POLL + 5;
    int processed = drainCommands(COMMAND_DRAIN_MAX_PER_POLL);
    TEST_ASSERT_EQUAL_INT(COMMAND_DRAIN_MAX_PER_POLL, processed);
    // Loop exits on the count cap, so no extra "empty" probe is made.
    TEST_ASSERT_EQUAL_INT(COMMAND_DRAIN_MAX_PER_POLL, s_getCalls);
    // Remaining commands are left for the next poll.
    TEST_ASSERT_EQUAL_INT(5, s_available);
}

// A backlog exactly equal to the budget drains fully without exceeding it.
void test_drain_backlog_equals_budget(void) {
    s_available = COMMAND_DRAIN_MAX_PER_POLL;
    int processed = drainCommands(COMMAND_DRAIN_MAX_PER_POLL);
    TEST_ASSERT_EQUAL_INT(COMMAND_DRAIN_MAX_PER_POLL, processed);
    TEST_ASSERT_EQUAL_INT(0, s_available);
}

// The configured budget must be a sane positive cap.
void test_drain_budget_constant_is_positive(void) {
    TEST_ASSERT_GREATER_THAN_INT(0, COMMAND_DRAIN_MAX_PER_POLL);
}

int main(int argc, char** argv) {
    (void)argc;
    (void)argv;
    UNITY_BEGIN();
    RUN_TEST(test_drain_empty_queue_processes_none);
    RUN_TEST(test_drain_backlog_below_budget_drains_all);
    RUN_TEST(test_drain_respects_max_per_poll_cap);
    RUN_TEST(test_drain_backlog_equals_budget);
    RUN_TEST(test_drain_budget_constant_is_positive);
    return UNITY_END();
}
