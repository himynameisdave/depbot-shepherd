- Require detailed upstream evidence and repository inspection establishing compatibility of
  the changed behaviour with this repository's usage. Passing CI supports that assessment.
- For a non-patch bump, skip if release notes or equivalent upstream evidence are missing or
  too thin to assess compatibility. Skip for unresolved compatibility questions relevant to
  the repository, even when tests pass; explain the specific question.
- Merge when relevant changes have been checked, the dependency diff is understood, and no
  material compatibility or security questions remain. Unrelated documentation changes and
  theoretical risks alone are not blockers.
