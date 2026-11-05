import { accountEnvRef, ENV_NAME, profileEnvRef, profileRootFor, type AgentAccount, type Profile, type SecretStore } from '@workhub/core'

/** `${FOLDER}` is the session folder and `${PROFILE_ROOT}` the profile folder holding it (else its first folder), as in Workhub 1. */
export function expandEnvValue(value: string, vars: { folder: string; profileRoot: string }): string {
  return value.replaceAll('${FOLDER}', vars.folder).replaceAll('${PROFILE_ROOT}', vars.profileRoot)
}

/** The variables a profile adds to the sessions it starts (values from the secret store). */
export async function profileSessionEnv(profile: Profile | undefined, cwd: string, secrets: Pick<SecretStore, 'get'>, home: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  if (!profile) return out
  const vars = { folder: cwd, profileRoot: profileRootFor(cwd, profile, home) ?? cwd }
  for (const name of profile.envNames ?? []) {
    if (!ENV_NAME.test(name)) continue
    const value = await secrets.get(profileEnvRef(profile.id, name))
    if (value !== null) out[name] = expandEnvValue(value, vars)
  }
  return out
}

/** Stores new values, forgets removed names. Names must be valid variable names. */
export async function saveProfileEnv(profileId: string, values: Record<string, string>, removed: string[], secrets: Pick<SecretStore, 'set' | 'delete'>): Promise<void> {
  for (const [name, value] of Object.entries(values)) if (ENV_NAME.test(name)) await secrets.set(profileEnvRef(profileId, name), value)
  for (const name of removed) if (ENV_NAME.test(name)) await secrets.delete(profileEnvRef(profileId, name))
}

export async function storedProfileEnvNames(profile: Profile | undefined, secrets: Pick<SecretStore, 'has'>): Promise<string[]> {
  const names: string[] = []
  for (const name of profile?.envNames ?? []) if (await secrets.has(profileEnvRef(profile!.id, name))) names.push(name)
  return names
}

/** The variables an agent account adds to its sessions, read from the secret store (names in `envNames`). */
export async function accountSessionEnv(account: Pick<AgentAccount, 'id' | 'envNames'> | null | undefined, secrets: Pick<SecretStore, 'get'>): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const name of account?.envNames ?? []) {
    if (!ENV_NAME.test(name)) continue
    const value = await secrets.get(accountEnvRef(account!.id, name))
    if (value !== null) out[name] = value
  }
  return out
}

/** Stores an account's new values and forgets its removed names. Names must be valid variable names. */
export async function saveAccountEnv(accountId: string, values: Record<string, string>, removed: string[], secrets: Pick<SecretStore, 'set' | 'delete'>): Promise<void> {
  for (const [name, value] of Object.entries(values)) if (ENV_NAME.test(name)) await secrets.set(accountEnvRef(accountId, name), value)
  for (const name of removed) if (ENV_NAME.test(name)) await secrets.delete(accountEnvRef(accountId, name))
}

/** The account's variable names that have a value in the secret store. */
export async function storedAccountEnvNames(account: Pick<AgentAccount, 'id' | 'envNames'> | undefined, secrets: Pick<SecretStore, 'has'>): Promise<string[]> {
  const names: string[] = []
  for (const name of account?.envNames ?? []) if (await secrets.has(accountEnvRef(account!.id, name))) names.push(name)
  return names
}
