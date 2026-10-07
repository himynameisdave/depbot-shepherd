- `merge` only when you verified nothing in the changes affects how this repository uses the
  package(s), the lockfile diff is clean, and you have no open questions. Say what you checked.
- `skip` when a breaking or behavioural change touches code this repository uses, when the release
  notes are missing or too thin to judge a non-patch bump, or when anything looks suspicious.
  Passing CI does not settle an open compatibility question.
- When in doubt, skip — a human will look at it; a bad merge costs more than a day's delay.
