// Single naming helper: Herdr agent name and pi `--name` must agree for a
// given {change}-{role}. Herdr enforces a 32-char agent-name limit; truncate
// the change id (keeping the role suffix intact) so both names match exactly.
// `attempt > 0` appends a numeric suffix (-2, -3, …) so concurrent workflows
// with the same changeId don't collide on the same herdr agent name.
const HERDR_NAME_LIMIT = 32;

export function agentName(changeId: string, role: string, attempt = 0): string {
  const suffix = `-${role}${attempt > 0 ? `-${attempt + 1}` : ''}`;
  const name = `${changeId}${suffix}`;
  return name.length <= HERDR_NAME_LIMIT ? name : `${changeId.slice(0, HERDR_NAME_LIMIT - suffix.length)}${suffix}`;
}
