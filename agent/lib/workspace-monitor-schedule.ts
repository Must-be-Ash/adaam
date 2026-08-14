import type { WorkspaceMonitorSchedule } from "./workspace-monitor-store";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const MAX_RECOVERY_WINDOW_MS = 7 * DAY_MS;
const SCAN_PADDING_MS = 2 * DAY_MS;
const formatters = new Map<string, Intl.DateTimeFormat>();

export interface WorkspaceMonitorOccurrenceTime {
  readonly occurrenceIdentity: string;
  readonly scheduledAt: string;
}

export interface WorkspaceMonitorDueSelection {
  readonly due: WorkspaceMonitorOccurrenceTime | null;
  readonly skipped: readonly WorkspaceMonitorOccurrenceTime[];
  readonly skippedBefore: string | null;
}

export class WorkspaceMonitorScheduleError extends Error {
  readonly code = "monitor_schedule_invalid";

  constructor() {
    super("The workspace monitor schedule is invalid or outside its bound.");
    this.name = "WorkspaceMonitorScheduleError";
  }
}

function invalid(): never {
  throw new WorkspaceMonitorScheduleError();
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  try {
    const created = new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      timeZone,
      year: "numeric",
    });
    formatters.set(timeZone, created);
    return created;
  } catch {
    return invalid();
  }
}

function localParts(
  instantMs: number,
  timeZone: string,
): { date: string; minutes: number; time: string } {
  const parts = formatter(timeZone).formatToParts(new Date(instantMs));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const year = value("year");
  const month = value("month");
  const day = value("day");
  const hour = value("hour");
  const minute = value("minute");
  if (!year || !month || !day || !hour || !minute) return invalid();
  return {
    date: `${year}-${month}-${day}`,
    minutes: Number(hour) * 60 + Number(minute),
    time: `${hour}:${minute}`,
  };
}

function parseLocalDate(value: string): {
  day: number;
  month: number;
  year: number;
} {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return invalid();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return invalid();
  }
  return { day, month, year };
}

function addLocalDays(date: string, days: number): string {
  const parsed = parseLocalDate(date);
  const next = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days));
  return `${next.getUTCFullYear().toString().padStart(4, "0")}-${(next.getUTCMonth() + 1)
    .toString()
    .padStart(2, "0")}-${next.getUTCDate().toString().padStart(2, "0")}`;
}

function compareLocal(
  left: { date: string; minutes: number },
  right: { date: string; minutes: number },
): number {
  return left.date === right.date
    ? left.minutes - right.minutes
    : left.date.localeCompare(right.date);
}

function resolveDailyLocal(
  date: string,
  time: string,
  timeZone: string,
): WorkspaceMonitorOccurrenceTime {
  const parsedDate = parseLocalDate(date);
  const timeMatch = /^(\d{2}):(\d{2})$/u.exec(time);
  if (!timeMatch) return invalid();
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (hour > 23 || minute > 59) return invalid();
  formatter(timeZone);
  const target = { date, minutes: hour * 60 + minute };
  const approximate = Date.UTC(
    parsedDate.year,
    parsedDate.month - 1,
    parsedDate.day,
    hour,
    minute,
  );
  const exact: number[] = [];
  const later: { instant: number; local: ReturnType<typeof localParts> }[] = [];
  for (
    let instant = approximate - 18 * 60 * MINUTE_MS;
    instant <= approximate + 48 * 60 * MINUTE_MS;
    instant += MINUTE_MS
  ) {
    const local = localParts(instant, timeZone);
    const comparison = compareLocal(local, target);
    if (comparison === 0) exact.push(instant);
    else if (comparison > 0) later.push({ instant, local });
  }
  const scheduled =
    exact.length > 0
      ? Math.min(...exact)
      : later.sort((left, right) => {
          const localOrder = compareLocal(left.local, right.local);
          return localOrder === 0 ? left.instant - right.instant : localOrder;
        })[0]?.instant;
  if (scheduled === undefined) return invalid();
  return Object.freeze({
    occurrenceIdentity: `daily:${date}:${time}`,
    scheduledAt: new Date(scheduled).toISOString(),
  });
}

function dailyOccurrencesForDate(
  schedule: Extract<WorkspaceMonitorSchedule, { kind: "daily_local" }>,
  date: string,
): WorkspaceMonitorOccurrenceTime[] {
  return schedule.times
    .map((time) => resolveDailyLocal(date, time, schedule.timezone))
    .sort(
      (left, right) =>
        new Date(left.scheduledAt).getTime() -
        new Date(right.scheduledAt).getTime(),
    );
}

export function nextWorkspaceMonitorOccurrence(
  schedule: WorkspaceMonitorSchedule,
  after: Date,
): WorkspaceMonitorOccurrenceTime | null {
  const afterMs = after.getTime();
  if (!Number.isFinite(afterMs)) return invalid();
  if (schedule.kind === "source_event") return null;
  if (schedule.kind === "one_time") {
    const at = new Date(schedule.at).getTime();
    return at > afterMs
      ? Object.freeze({
          occurrenceIdentity: `one_time:${schedule.at}`,
          scheduledAt: new Date(at).toISOString(),
        })
      : null;
  }
  if (schedule.kind === "interval") {
    const anchor = new Date(schedule.anchor).getTime();
    const interval = schedule.everyMinutes * MINUTE_MS;
    if (!Number.isFinite(anchor) || !Number.isSafeInteger(interval)) return invalid();
    const steps = afterMs < anchor ? 0 : Math.floor((afterMs - anchor) / interval) + 1;
    const scheduled = anchor + steps * interval;
    return Object.freeze({
      occurrenceIdentity: `interval:${new Date(scheduled).toISOString()}`,
      scheduledAt: new Date(scheduled).toISOString(),
    });
  }

  let date = localParts(afterMs, schedule.timezone).date;
  for (let day = 0; day < 4; day += 1) {
    const next = dailyOccurrencesForDate(schedule, date).find(
      (occurrence) => new Date(occurrence.scheduledAt).getTime() > afterMs,
    );
    if (next) return next;
    date = addLocalDays(date, 1);
  }
  return invalid();
}

function occurrencesBetween(
  schedule: WorkspaceMonitorSchedule,
  startInclusiveMs: number,
  endInclusiveMs: number,
): {
  occurrences: WorkspaceMonitorOccurrenceTime[];
  truncatedBefore: string | null;
} {
  if (schedule.kind === "source_event" || startInclusiveMs > endInclusiveMs) {
    return { occurrences: [], truncatedBefore: null };
  }
  if (schedule.kind === "one_time") {
    const at = new Date(schedule.at).getTime();
    return {
      occurrences:
        at >= startInclusiveMs && at <= endInclusiveMs
          ? [
              Object.freeze({
                occurrenceIdentity: `one_time:${schedule.at}`,
                scheduledAt: new Date(at).toISOString(),
              }),
            ]
          : [],
      truncatedBefore: null,
    };
  }
  if (schedule.kind === "interval") {
    const anchor = new Date(schedule.anchor).getTime();
    const interval = schedule.everyMinutes * MINUTE_MS;
    let firstStep = Math.max(0, Math.ceil((startInclusiveMs - anchor) / interval));
    const lastStep = Math.floor((endInclusiveMs - anchor) / interval);
    const count = Math.max(0, lastStep - firstStep + 1);
    const truncatedBefore =
      count > 256
        ? new Date(anchor + (lastStep - 255) * interval).toISOString()
        : null;
    if (count > 256) firstStep = lastStep - 255;
    const result: WorkspaceMonitorOccurrenceTime[] = [];
    for (
      let scheduled = anchor + firstStep * interval;
      scheduled <= endInclusiveMs && result.length < 256;
      scheduled += interval
    ) {
      result.push(
        Object.freeze({
          occurrenceIdentity: `interval:${new Date(scheduled).toISOString()}`,
          scheduledAt: new Date(scheduled).toISOString(),
        }),
      );
    }
    return { occurrences: result, truncatedBefore };
  }

  let date = localParts(startInclusiveMs - DAY_MS, schedule.timezone).date;
  const endDate = localParts(endInclusiveMs + DAY_MS, schedule.timezone).date;
  const result: WorkspaceMonitorOccurrenceTime[] = [];
  for (let days = 0; days < 16 && date <= endDate; days += 1) {
    for (const occurrence of dailyOccurrencesForDate(schedule, date)) {
      const instant = new Date(occurrence.scheduledAt).getTime();
      if (instant >= startInclusiveMs && instant <= endInclusiveMs) {
        result.push(occurrence);
      }
    }
    date = addLocalDays(date, 1);
  }
  return {
    occurrences: result.sort(
      (left, right) =>
        new Date(left.scheduledAt).getTime() -
        new Date(right.scheduledAt).getTime(),
    ),
    truncatedBefore: null,
  };
}

export function selectWorkspaceMonitorDueOccurrence(input: {
  completedOccurrenceIdentities?: readonly string[];
  nextOccurrenceAt: string;
  now: Date;
  recoveryWindowMs: number;
  schedule: WorkspaceMonitorSchedule;
}): WorkspaceMonitorDueSelection {
  const nowMs = input.now.getTime();
  const nextMs = new Date(input.nextOccurrenceAt).getTime();
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(nextMs) ||
    !Number.isSafeInteger(input.recoveryWindowMs) ||
    input.recoveryWindowMs < 0 ||
    input.recoveryWindowMs > MAX_RECOVERY_WINDOW_MS
  ) {
    return invalid();
  }
  if (nextMs > nowMs) {
    return Object.freeze({ due: null, skipped: Object.freeze([]), skippedBefore: null });
  }
  const recoveryStart = nowMs - input.recoveryWindowMs;
  const scanStart = Math.max(nextMs, recoveryStart - SCAN_PADDING_MS);
  const completed = new Set(input.completedOccurrenceIdentities ?? []);
  const scanned = occurrencesBetween(input.schedule, scanStart, nowMs);
  const occurrences = scanned.occurrences.filter(
    (occurrence) =>
      new Date(occurrence.scheduledAt).getTime() >= nextMs &&
      !completed.has(occurrence.occurrenceIdentity),
  );
  const recoverable = occurrences.filter(
    (occurrence) =>
      new Date(occurrence.scheduledAt).getTime() >= recoveryStart,
  );
  const due = recoverable.at(-1) ?? null;
  const skipped = occurrences.filter(
    (occurrence) => occurrence.occurrenceIdentity !== due?.occurrenceIdentity,
  );
  return Object.freeze({
    due,
    skipped: Object.freeze(skipped),
    skippedBefore:
      nextMs < scanStart
        ? new Date(scanStart).toISOString()
        : scanned.truncatedBefore,
  });
}
