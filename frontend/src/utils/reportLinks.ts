const REPO_URL = 'https://github.com/simonmd82/pz-room-furnisher';

/** New-issue link for an issue form; fields are prefilled by the form's field ids. */
export function issueUrl(template: 'bad-result.yml' | 'bug.yml', fields: Record<string, string | number>): string {
  const params = new URLSearchParams({ template });
  for (const [id, value] of Object.entries(fields)) {
    if (value !== '') params.set(id, String(value));
  }
  return `${REPO_URL}/issues/new?${params}`;
}
