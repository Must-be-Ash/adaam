import assert from "node:assert/strict";

import {
  nextWorkspaceMonitorOccurrence,
  selectWorkspaceMonitorDueOccurrence,
} from "../agent/lib/workspace-monitor-schedule";

const springSchedule = {
  kind: "daily_local" as const,
  times: ["02:30"],
  timezone: "America/New_York",
};
assert.deepEqual(
  nextWorkspaceMonitorOccurrence(
    springSchedule,
    new Date("2026-03-08T06:59:59.000Z"),
  ),
  {
    occurrenceIdentity: "daily:2026-03-08:02:30",
    scheduledAt: "2026-03-08T07:00:00.000Z",
  },
);

const fallSchedule = {
  kind: "daily_local" as const,
  times: ["01:30"],
  timezone: "America/New_York",
};
const fallOccurrence = nextWorkspaceMonitorOccurrence(
  fallSchedule,
    new Date("2026-11-01T04:00:00.000Z"),
);
assert.deepEqual(fallOccurrence, {
  occurrenceIdentity: "daily:2026-11-01:01:30",
  scheduledAt: "2026-11-01T05:30:00.000Z",
});
assert.deepEqual(
  nextWorkspaceMonitorOccurrence(
    fallSchedule,
    new Date("2026-11-01T05:30:00.000Z"),
  ),
  {
    occurrenceIdentity: "daily:2026-11-02:01:30",
    scheduledAt: "2026-11-02T06:30:00.000Z",
  },
);

const twiceDaily = {
  kind: "daily_local" as const,
  times: ["09:00", "16:00"],
  timezone: "UTC",
};
assert.deepEqual(
  selectWorkspaceMonitorDueOccurrence({
    nextOccurrenceAt: "2026-08-14T09:00:00.000Z",
    now: new Date("2026-08-14T17:00:00.000Z"),
    recoveryWindowMs: 10 * 60 * 60_000,
    schedule: twiceDaily,
  }),
  {
    due: {
      occurrenceIdentity: "daily:2026-08-14:16:00",
      scheduledAt: "2026-08-14T16:00:00.000Z",
    },
    skipped: [
      {
        occurrenceIdentity: "daily:2026-08-14:09:00",
        scheduledAt: "2026-08-14T09:00:00.000Z",
      },
    ],
    skippedBefore: null,
  },
);
assert.deepEqual(
  selectWorkspaceMonitorDueOccurrence({
    nextOccurrenceAt: "2026-08-14T09:00:00.000Z",
    now: new Date("2026-08-14T17:00:00.000Z"),
    recoveryWindowMs: 30 * 60_000,
    schedule: twiceDaily,
  }),
  {
    due: null,
    skipped: [
      {
        occurrenceIdentity: "daily:2026-08-14:09:00",
        scheduledAt: "2026-08-14T09:00:00.000Z",
      },
      {
        occurrenceIdentity: "daily:2026-08-14:16:00",
        scheduledAt: "2026-08-14T16:00:00.000Z",
      },
    ],
    skippedBefore: null,
  },
);
assert.ok(
  selectWorkspaceMonitorDueOccurrence({
    nextOccurrenceAt: "2026-07-01T09:00:00.000Z",
    now: new Date("2026-08-14T17:00:00.000Z"),
    recoveryWindowMs: 30 * 60_000,
    schedule: twiceDaily,
  }).skippedBefore,
);
assert.equal(
  selectWorkspaceMonitorDueOccurrence({
    completedOccurrenceIdentities: ["daily:2026-08-14:16:00"],
    nextOccurrenceAt: "2026-08-14T16:00:00.000Z",
    now: new Date("2026-08-14T17:00:00.000Z"),
    recoveryWindowMs: 2 * 60 * 60_000,
    schedule: twiceDaily,
  }).due,
  null,
);

const interval = {
  anchor: "2026-08-14T12:00:00.000Z",
  everyMinutes: 30,
  kind: "interval" as const,
};
assert.deepEqual(
  nextWorkspaceMonitorOccurrence(
    interval,
    new Date("2026-08-14T12:44:00.000Z"),
  ),
  {
    occurrenceIdentity: "interval:2026-08-14T13:00:00.000Z",
    scheduledAt: "2026-08-14T13:00:00.000Z",
  },
);
assert.deepEqual(
  selectWorkspaceMonitorDueOccurrence({
    nextOccurrenceAt: "2026-08-14T12:00:00.000Z",
    now: new Date("2026-08-14T13:01:00.000Z"),
    recoveryWindowMs: 2 * 60 * 60_000,
    schedule: interval,
  }).due,
  {
    occurrenceIdentity: "interval:2026-08-14T13:00:00.000Z",
    scheduledAt: "2026-08-14T13:00:00.000Z",
  },
);
const boundedCatchup = selectWorkspaceMonitorDueOccurrence({
  nextOccurrenceAt: "2026-08-07T12:00:00.000Z",
  now: new Date("2026-08-14T17:00:00.000Z"),
  recoveryWindowMs: 7 * 24 * 60 * 60_000,
  schedule: {
    anchor: "2026-08-01T00:00:00.000Z",
    everyMinutes: 15,
    kind: "interval",
  },
});
assert.equal(boundedCatchup.due?.scheduledAt, "2026-08-14T17:00:00.000Z");
assert.equal(boundedCatchup.skipped.length, 255);
assert.ok(boundedCatchup.skippedBefore);

console.log("Workspace monitor schedule verification passed.");
