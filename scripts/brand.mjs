/**
 * The one place that names the product. productName, appId and the release repository are used by
 * electron-builder, the install/release scripts and the CI workflows; change them here only.
 *
 * Workhub 1 is installed as /Applications/Workhub.app with bundle id com.nehuenfortes.workhub.
 * Workhub 2 coexists with it (different name, id and data folder) until the transition ends.
 * When it replaces Workhub 1, set productName to 'Workhub' and keep the appId stable from then on:
 * it keys the app's settings, keychain items and (on Windows) upgrade identity.
 */
export const BRAND = {
  productName: 'Workhub 2',
  appId: 'io.github.soldiericed.workhub2',
  /** Lowercase, no spaces: the Linux executable and the file names of the artifacts. */
  slug: 'workhub2',
  copyright: 'Copyright (c) Workhub contributors',
  repo: { owner: 'SoldierIced', name: 'workhub' }
}

// `node scripts/brand.mjs productName` prints one field, for the shell scripts.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const key = process.argv[2]
  const value = key === 'repo' ? `${BRAND.repo.owner}/${BRAND.repo.name}` : BRAND[key]
  if (typeof value !== 'string') {
    console.error(`usage: brand.mjs <productName|appId|slug|repo>`)
    process.exit(2)
  }
  console.log(value)
}
