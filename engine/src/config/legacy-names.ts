/**
 * COMPATIBILITY MAP. The only place these earlier names are written.
 *
 * Engines set up before the names below were made neutral may still send or
 * store the old ones: an `engine.yaml` written then, and a caretaker that has
 * not been updated. They are still ACCEPTED, read as today's names, and never
 * written back. They are not part of the documented config: do not add them
 * to docs, examples or new configs, and do not add new entries here.
 *
 * To drop the compatibility once no deployment uses an old name, delete the
 * entries; nothing else in the service names them.
 */

/** Sensor kinds in the `dashboard` config section: earlier name -> today's. */
export const LEGACY_SENSOR_KINDS: Readonly<Record<string, string>> = {
  hermes_job: "agent_job",
  archon_jobs: "workshop_jobs",
};

/** Keys of the caretaker snapshot's `sensors`: earlier name -> today's. */
export const LEGACY_SNAPSHOT_KEYS: Readonly<Record<string, string>> = {
  archon: "workshop",
};

/** "old_kind:rest" -> "new_kind:rest"; anything else is returned unchanged. */
export function normalizeSensor(sensor: string): string {
  const [kind = "", ...rest] = sensor.split(":");
  const mapped = Object.hasOwn(LEGACY_SENSOR_KINDS, kind)
    ? LEGACY_SENSOR_KINDS[kind]
    : undefined;
  return mapped ? [mapped, ...rest].join(":") : sensor;
}

/** A snapshot sensor key as it is named today. */
export function currentSnapshotKey(key: string): string {
  return Object.hasOwn(LEGACY_SNAPSHOT_KEYS, key)
    ? (LEGACY_SNAPSHOT_KEYS[key] ?? key)
    : key;
}
